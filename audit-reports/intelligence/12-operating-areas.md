# 12 · Operating areas, units & plants

**11 findings** — 1 CRITICAL · 4 HIGH · 6 MEDIUM.

Whether giving an area a drawing populates its equipment.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| lib/areaKnowledge.ts — the folder-matching and drift engine is pure, small, well-commented and genuinely well-tested (whole-word matching, GENERIC token exclusion so 'Utilities Unit' never matches 'Crude Unit', code-as-standalone-token so 'Unit 120' does not match code '20', regex-metacharacter safety for codes like '20(A)') | `lib/areaKnowledge.ts:25-120; lib/__tests__/areaKnowledge.test.ts:17-57` | This is the correct shape for the whole area layer — pure logic, routes feed it plain data. Any fix to the area↔knowledge binding should extend this module rather than add heuristics in the route or the component. |
| /api/area/knowledge-status fails loudly on every partial read instead of degrading to a false 'nothing here' — a failed documents page, a failed sources read, a failed kdocs page and a failed mirrored-document lookup each return 500 with a specific message, with comments explaining exactly which lie each guard prevents | `app/api/area/knowledge-status/route.ts:82, 149, 159, 211` | Drift detection is a data-loss warning; a silent zero would paint a false 'everything moved out' banner. This route is the reference for how the other area surfaces should handle partial failures — several of them (AreaKnowledgePanel's counting effect at :148, listProcessFlows callers) still swallow errors into zeros. |
| The area↔knowledge binding is written server-side on purpose, with the reason documented: the codebook RLS write policy checks only the headline role column, so a client update would silently affect zero rows for a member whose DocCtrl authority lives in the additive roles[] array | `app/api/area/knowledge-status/route.ts:265-289; lib/codebook.ts:382-387; lib/knowledgeAccess.ts:31-45` | loadPrincipal's `roles.has('Admin') \|\| roles.has('DocCtrl')` over `[member.role, ...member.roles]` is the correct authority check in this codebase. /api/equipment-bridge/route.ts:37-40 does NOT use it — it reads only `member.role` — so a DocCtrl-by-additive-role user is wrongly denied the sweep. |
| The Bridge's registry discovery is idempotent, race-safe and provenance-complete once it is allowed to run: unique (org, tag_normalized) makes concurrent discovery resolve to the winner's row, per-tag failures never sink the batch, unit backfill touches only NULL rows, column population is an array union that never removes a human-typed tag, and every applied run writes an EQUIPMENT_BRIDGE_APPLIED audit row | `lib/equipmentBridgeServer.ts:217-234, 240-258, 260-296` | The mechanism the owner wants for question 6 already exists and is careful. Only its entry conditions are wrong (the targetColumnKey gate, and no entry point from the operating areas). Fixing the gate unlocks working machinery rather than requiring new machinery. |
| /api/flows/read is genuinely grounded: the model may only emit roster handles the server built from real registry assets and real codebook units, unresolvable handles are dropped at parse, self-edges are rejected, and already-decided pairs are skipped | `app/api/flows/read/route.ts:67-71, 92-104, 144-166` | A hallucinated vessel cannot enter the plant topology. The grounding contract is right; the defect is the roster's 300-row slice and its org-wide scope, which are inputs to this contract rather than flaws in it. |
| ReadFlowsModal's per-document AI-state diagnosis — every blocked document says WHY (not linked / not synced / no PDF / superseded / no file / held back) and offers the in-place fix (Sync now, Link to AI) instead of a dead end | `components/assets/UnitOpsPanels.tsx:426-492, 339-360` | This is the best 'why is nothing happening' surface in the area layer and the model the equipment-populate path should copy: when a P&ID does not produce equipment, the area page should say which of the preconditions failed, in exactly this shape. |
| The Facility Setup navigator reads live counts with `count: 'exact', head: true` and tolerates missing tables by reading as zero — the counts are real, not a checklist, and a pre-migration workspace reports honestly | `app/(protected)/setup/page.tsx:55-107` | It is the one place that already counts uncategorized and unit-less assets correctly (:80-81), so it is where a 'code vs unit_code conflict' count and a 'documents with pending equipment suggestions' count belong. |
| codebook_entries and codebook_config are correctly locked to Admin/DocCtrl for writes with member-wide SELECT, and the codec degrades to 'no opinion' on an empty codebook so a facility with no codebook behaves exactly as before | `supabase/migrations/20260928_site_codebook.sql (codebook_entries_write / codebook_config_write); lib/codebook.ts:91-96, 322-346` | Operating-area DEFINITIONS have the right authority model. It is the contrast that makes assets_member_all indefensible: the label on the shelf is protected and the equipment on it is not. |


---


<a id="area-1"></a>

## AREA-1 · The equipment registry has no write authority at all — RLS is FOR ALL to every active member, while the Operating Areas page prints a role restriction that does not exist

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260605_rls_policies_new_tables.sql:24-29`, `app/(protected)/admin/assets/page.tsx:56`, `app/(protected)/admin/assets/page.tsx:348-352`, `lib/assets.ts:172-220`

**Mechanism.** The only policy ever written for `assets` is `CREATE POLICY "assets_member_all" ON assets FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active')) WITH CHECK (…same…)` (20260605_rls_policies_new_tables.sql:26-29). No later migration narrows it — three differently-shaped searches over supabase/migrations (`POLICY … assets` word-match, `ON assets` grep, and a case-insensitive `assets_(insert|update|delete|write|member)` regex) return only that one policy plus `document_assets_member_all`. Meanwhile every registry mutation is a bare client-side PostgREST call under the user's own JWT: `deleteAsset` is `await supabase.from("assets").delete().eq("id", id)` (lib/assets.ts:217-220); `updateAsset` and `createAsset` are the same shape. The page's only gate is a client constant — `const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"]` (page.tsx:56) — used purely to hide buttons, and it renders an explicit promise to everyone else: "Only Admin / Doc Control / Manager / Supervisor roles can create or edit assets. Your role: {activeRole}. You can still browse + view photos." (page.tsx:348-352). types/schema.ts:5-24 lists 19 roles; 15 of them (Engineer-1..4, Requester, Drafter, Accounting, Safety, HR, Maintenance, Operations, Contractor, Viewer, Auditor, DraftingSupervisor) receive that banner while holding full DELETE authority on the table.

**Failure scenario.** An Auditor (or any Contractor with an active membership) opens the browser console on /admin/assets and runs `await supabase.from('assets').delete().eq('org_id', <org>)`. Every equipment record in the PSM registry — tags, site codes, unit filing, discovered-from provenance — is gone, together with `asset_photos` and `document_assets` rows via cascade. Less dramatically: they can set `unit_code` on 400 assets to the wrong operating area, silently refiling the plant, with no audit row (updateAsset writes only updated_by/updated_at; nothing calls emit()).

**Evidence.**

```
supabase/migrations/20260605_rls_policies_new_tables.sql:26-29 — `CREATE POLICY "assets_member_all" ON assets FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active')) WITH CHECK (…)`. app/(protected)/admin/assets/page.tsx:349-351 — `Only Admin / Doc Control / Manager / Supervisor roles can create or edit assets. Your role: <b>{activeRole}</b>. You can still browse + view photos.` Contrast codebook_entries, which IS locked: supabase/migrations/20260928_site_codebook.sql — `CREATE POLICY codebook_entries_write … role IN ('Admin', 'DocCtrl')`. So operating-area DEFINITIONS are protected and the equipment inside them is not.
```

**Done when.**

- [ ] A migration replaces assets_member_all with split policies: SELECT for active members, INSERT/UPDATE/DELETE gated on the same authority the UI claims (reuse is_org_controller(org_id) from 20260814_documents_delete_controllers.sql:31-40, extended to Manager/Supervisor if that is the intended bar, so the additive roles[] array is honoured).
- [ ] The same split is applied to asset_types (20260605:17-22) and asset_photos (20260605:31-36), which carry the identical FOR ALL policy.
- [ ] A test in the style of the existing API-route authorization tests proves a Viewer JWT gets 42501 on assets INSERT/UPDATE/DELETE.
- [ ] The page.tsx:349 banner text is verified against the new policy so the copy and the database say the same thing.

---

<a id="area-2"></a>

## AREA-2 · Any active member can permanently delete every document↔equipment link in the org, and create new ones, straight from the client

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260609_phase1_normalization.sql:186-190`, `app/(protected)/admin/assets/page.tsx:1345-1354`, `app/(protected)/graph/page.tsx:356-362`, `lib/operationalGraph.ts:372-377`

**Mechanism.** `CREATE POLICY "document_assets_member_all" ON document_assets FOR ALL … USING (EXISTS (SELECT 1 FROM org_members … status='active')) WITH CHECK (…)` (20260609_phase1_normalization.sql:186-190; duplicated in CATCHUP_2026-05-28.sql:468-472). document_assets is the join that makes the Operating Areas page's "Documents referencing this unit's equipment" panel work (page.tsx:1089-1173 via getDocumentsForAssetsHydrated) and is the evidence trail linking a P&ID to the vessel it governs. Both writers are unguarded client calls: the asset drawer's unlink is `await supabase.from("document_assets").delete().eq("document_id", documentId).eq("asset_id", asset.id)` (page.tsx:1352-1353) and the graph's Connect mode inserts directly (graph/page.tsx:359-362). Critically, app/(protected)/graph/page.tsx contains no role check whatsoever — grep for `activeRole`, `isAdmin`, `isController` in that file returns nothing; the Connect affordance is offered to any node kind at line 871-873 with no gate.

**Failure scenario.** A Contractor with read-only intent opens the graph, selects a P&ID node, hits Connect, and picks the wrong vessel — a false document↔equipment link is now permanent org data feeding the unit hub, the graph, the equipment sweep's diff base, and the /assets/[tag] backlinks hub. Or, from the console, `supabase.from('document_assets').delete().eq('org_id', <org>)` erases the entire paper-to-plant mapping the Bridge spent CPU building; the Operating Areas page's UnitDocuments panel goes silently empty (rows.length === 0 returns null, page.tsx:1150) and nothing in the app reports the loss.

**Evidence.**

```
supabase/migrations/20260609_phase1_normalization.sql:187-190 — `CREATE POLICY "document_assets_member_all" ON document_assets FOR ALL TO authenticated USING (…active member…) WITH CHECK (…active member…)`. app/(protected)/graph/page.tsx:871-873 — `onConnect={["doc:", "asset:", "cbunit:", "unit:"].some((pre) => selected.id.startsWith(pre)) ? () => { setConnect({ from: selected, status: "picking" }); … } : undefined}` — the only condition is the node's id prefix.
```

**Done when.**

- [ ] document_assets gets SELECT-for-members plus writer-gated INSERT/UPDATE/DELETE, matching whatever bar the sweep and the drawer claim.
- [ ] app/(protected)/graph/page.tsx gates Connect mode on the same authority (it currently reads uid and activeOrgId from useRole but never activeRole).
- [ ] Deleting a link that the Bridge applied is either blocked or recorded, so `document_equipment_suggestions.applied` and the real link set cannot drift apart unnoticed.

---

<a id="area-3"></a>

## AREA-3 · Any active member can write a CONFIRMED process flow into the plant topology, and every such row permanently blinds the AI PFD reader to that pair

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261017_process_flows.sql:50-56`, `app/(protected)/graph/page.tsx:309-347`, `app/api/flows/read/route.ts:42-48`, `app/api/flows/read/route.ts:82-88`, `lib/processFlows.ts:52-70`

**Mechanism.** process_flows.status defaults to 'confirmed' (20261017:24) and the INSERT policy checks nothing but membership and authorship: `CREATE POLICY process_flows_insert ON process_flows FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE … m.status='active') AND created_by = auth.uid())` — no status constraint, no controller check. `createManualFlow` (lib/processFlows.ts:59-69) is a direct client insert with `status: "confirmed"`, reachable from the graph's Connect mode which, as above, has no role gate. The write authority is inconsistent with the two surfaces that surround it: /api/flows/read refuses anyone outside `["Admin", "DocCtrl"]` (route.ts:46-48) and the unit hub hides accept/dismiss behind isAdmin (UnitOpsPanels.tsx:209). Worse, the reader treats EVERY existing row as a settled decision: it loads all process_flows and builds `settled` from `${from_kind}:${from_ref}>${to_kind}:${to_ref}` (route.ts:82-88), then `if (settled.has(key)) { skippedSettled += 1; continue; }` (route.ts:150). A junk row is therefore not merely noise — it permanently suppresses the AI's ability to ever propose that connection again.

**Failure scenario.** A curious Operations user walks the graph, connects two vessels the wrong way round, and a fabricated feed direction becomes org truth on the Process lens and in the crude unit's FlowPanel. Later a DocCtrl user runs the real PFD read; the model correctly reads the true direction, the route hits `settled`, increments skippedSettled, and returns 'No new flows found — the drawing may not print flow arrows between known tags, or everything visible was already decided.' (route.ts:179). The correct reading is silently discarded and the message blames the drawing.

**Evidence.**

```
supabase/migrations/20261017_process_flows.sql:24 — `status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed','dismissed'))`; :50-56 — the INSERT policy with no status or role condition. app/api/flows/read/route.ts:150 — `if (settled.has(key)) { skippedSettled += 1; continue; }`. app/api/flows/read/route.ts:46 — `!['Admin', 'DocCtrl'].includes(m.role ?? '')` → 403.
```

**Done when.**

- [ ] process_flows INSERT is restricted to controllers, or to `status = 'proposed'` for non-controllers so a human decision still gates the topology.
- [ ] Graph Connect mode is role-gated to match.
- [ ] The reader distinguishes 'a human decided this' from 'a row exists': settled should be built from rows with decided_at set (or origin='ai' dismissals), so a stray manual row cannot silently suppress a correct reading, and skippedSettled > 0 is surfaced to the user instead of being folded into the generic 'no flows found' note.

---

<a id="area-4"></a>

## AREA-4 · Owner question 5, answered: a P&ID given to an area never populates that area's equipment — the Bridge aborts before creating a single asset unless a controller first maps a metadata column on the source library, from a modal the Operating Areas page cannot reach

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:189-193`, `lib/equipmentBridgeServer.ts:198-234`, `app/(protected)/documents/[libraryId]/page.tsx:4685`, `components/documents/EquipmentSweepModal.tsx:157`, `app/(protected)/admin/assets/page.tsx:1-50`

**Mechanism.** `applyForDocument` loads the library's bridge config and then, BEFORE any registry work, executes `const targetKey = bridge?.targetColumnKey; if (!targetKey) { throw new Error("No equipment column mapped for this library — pick one in the sweep dialog first."); }` (equipmentBridgeServer.ts:190-193). Asset discovery — the `if (bridge?.createAssets !== false)` block that inserts DISCOVERED assets with `unit_code`, `code`, `origin: "drawing"` and provenance — lives at lines 198-234, i.e. downstream of that throw. So the document-column mapping, whose stated job is populating a spreadsheet column, is also the hard gate on populating the equipment registry. Auto-apply has the same gate: `if (bridge?.autoApply && bridge.targetColumnKey)` (line 128). The mapping is set only through `<select value={bridge.targetColumnKey ?? ""} …>` in EquipmentSweepModal.tsx:157, and that modal is imported in exactly one place — app/(protected)/documents/[libraryId]/page.tsx:40 and rendered at :4685 (confirmed by two greps: `EquipmentSweepModal` across .ts/.tsx, and `equipment-bridge|computeForKnowledgeDoc|applyForDocument` across the tree). app/(protected)/admin/assets/page.tsx imports nothing from lib/equipmentBridgeServer or /api/equipment-bridge; the AreaKnowledgePanel's four-step order of operations (AreaKnowledgePanel.tsx:314-349) never mentions the sweep.

**Failure scenario.** An engineer opens the Crude Unit, uses the AreaKnowledgePanel wizard to bind P&IDs/Crude Unit as the area's knowledge, waits for ingest, and expects the unit's equipment list to fill in. It stays empty forever. Nothing on the area page says why. The actual next step — Documents → that library → Equipment sweep → pick a target column → Apply — is neither linked from the area nor mentioned in the checklist, and the failure message that would explain it ('No equipment column mapped for this library') is only ever raised inside a modal on a different page.

**Evidence.**

```
lib/equipmentBridgeServer.ts:190-193 — `const targetKey = bridge?.targetColumnKey; if (!targetKey) { throw new Error("No equipment column mapped for this library — pick one in the sweep dialog first."); }`, followed at :200 by `if (bridge?.createAssets !== false) {` … `await admin.from("assets").insert(insert)`. app/api/equipment-bridge/route.ts:135-139 catches the throw per document and returns `{ documentId, error }` — the sweep UI is the only place that error is ever shown.
```

**Done when.**

- [ ] Registry discovery is separated from column population: unmatched tags become assets even when no target column is mapped (or the mapping requirement is stated on the area page, not buried in a library modal).
- [ ] The AreaKnowledgePanel checklist gains a real step between 'connect the knowledge' and 'deep read' — 'populate this area's equipment from its drawings' — showing the live count of document_equipment_suggestions rows pending for the area's watched libraries and launching the sweep in place.
- [ ] A P&ID bound to an area and indexed produces registry assets end to end without the user visiting /documents/[libraryId].

---

<a id="area-5"></a>

## AREA-5 · The PFD reader can only see the first 300 assets of an unordered query, and is never scoped to the unit whose panel launched it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:57-71`, `components/assets/UnitOpsPanels.tsx:250-254`, `components/assets/UnitOpsPanels.tsx:265-269`, `app/api/flows/browse/route.ts:38-46`

**Mechanism.** The route fetches `supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false).limit(4000)` with NO `.order(...)` (route.ts:58), then builds the model's roster from `assets.slice(0, 300)` (route.ts:68). Postgres returns unordered rows, so which 300 assets the model is allowed to name is nondeterministic across calls. The prompt then forbids anything else: "Use ONLY the roster handles (A1, U2, …). Connect an entity only when its tag or unit is PRINTED on the drawing… Never guess" (route.ts:95-98), and the parser drops any handle not in byRef (`if (!from || !to …) continue`, route.ts:148). Separately, FlowPanel receives `unitCode` and `unitAssets` but passes neither into ReadFlowsModal — `<ReadFlowsModal orgId={orgId} onClose={…} onDone={…} />` (UnitOpsPanels.tsx:251-253) — and the modal calls `/api/flows/browse?orgId=…` with no unit parameter (UnitOpsPanels.tsx:294; browse route.ts:38-46 reads only orgId). The reader is an org-wide tool wearing a unit-hub button.

**Failure scenario.** A 1,200-asset refinery opens the Crude Unit, clicks 'Read flows from a document', picks the crude PFD. The roster is 300 arbitrary assets — statistically ~75 of them crude, most of them from other units. The model reads E-101 → V-102 correctly off the drawing, finds no handle for either, emits nothing, and the user is told 'No new flows found — the drawing may not print flow arrows between known tags' (route.ts:179). The drawing was fine; the roster was. Re-running can produce a different 300 and therefore a different answer for the same PDF.

**Evidence.**

```
app/api/flows/read/route.ts:58 — `supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false).limit(4000)` (no order). :68 — `assets.slice(0, 300).forEach((a, i) => roster.push({ ref: `A${i + 1}`, kind: "asset", id: a.id, label: a.tag }));`. components/assets/UnitOpsPanels.tsx:251 — `<ReadFlowsModal orgId={orgId} onClose={() => setReaderOpen(false)} onDone={…} />` — unitCode is in scope at :110 and not passed.
```

**Done when.**

- [ ] The roster is selected deliberately, not sliced: when the reader is launched from a unit hub it takes unitCode and prioritises that unit's assets (plus codebook units) before filling the remainder; the query gets a deterministic `.order("tag")`.
- [ ] When the registry exceeds the roster budget the response says so explicitly instead of returning the generic 'No new flows found' note.
- [ ] ReadFlowsModal accepts and forwards the unit so /api/flows/browse can default its library filter to the area's bound knowledge library.

---

<a id="area-6"></a>

## AREA-6 · No pivot from an operating area to the graph — the deep link the graph already understands is used by nothing, and even it only selects a node rather than scoping the view

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:226-237`, `lib/orgGraph.ts:198-202`, `components/assets/UnitOpsPanels.tsx:176-178`, `app/(protected)/admin/assets/page.tsx:1602`, `components/assets/AreaKnowledgePanel.tsx:231-350`

**Mechanism.** orgGraph gives every codebook unit a namespaced node id `cbunit:<code>` (orgGraph.ts:199) and graph/page.tsx explicitly supports focusing it: 'Namespaced ids ("asset:…", "cbunit:20") focus any node kind' — `const id = focusParam.includes(":") ? focusParam : `doc:${focusParam}`` (:229-231). Two differently-shaped searches (`cbunit` across .ts/.tsx, and `focus=` across the tree) find exactly three producers of a focus link — RelationshipGraph.tsx:100 (`/graph?focus=${documentId}`) and admin/assets/page.tsx:1602 (`/graph?focus=asset:${asset.id}`) — and none of them emits a cbunit focus. The unit hub's only graph exit is `<Link href="/graph">Process lens →</Link>` (UnitOpsPanels.tsx:176-178): the org-wide graph, no unit, no focus. AreaKnowledgePanel links to /knowledge, /documents and /plot-plans and never to the graph at all. And the focus handler is weaker than the owner's ask anyway: it calls `setSelected(node)` and `setHighlight(...)` (:234-235) — it never calls `setFocusId`, which is the local-depth scope, and is set only by NodePeek's 'Go in' (:866).

**Failure scenario.** Standing in the Crude Unit hub with its equipment, flows and documents on screen, the user asks the product's own question — 'crude unit: all of this goes here' — and the only available move is a link to the whole-plant graph, where they must find the Crude Unit node among every document, library, project and asset in the org and click 'Go in' by hand. The one-line affordance (`/graph?focus=cbunit:${unit.code}`) exists on the graph side and is wired by nobody.

**Evidence.**

```
app/(protected)/graph/page.tsx:229-235 — `// Namespaced ids ("asset:…", "cbunit:20") focus any node kind` … `if (node) { setSelected(node); setHighlight({ ids: [id], nonce: Date.now() }); }` — note no setFocusId. components/assets/UnitOpsPanels.tsx:176-178 — `<Link href="/graph" …>Process lens →</Link>`. lib/orgGraph.ts:199-201 — `nodes.set(`cbunit:${u.code}`, { … href: `/admin/assets?unit=${encodeURIComponent(u.code)}` … })` — the area→graph direction is the missing half of a round trip whose other half already exists.
```

**Done when.**

- [ ] The unit hub header and FlowPanel link to `/graph?focus=cbunit:<code>`, closing the round trip orgGraph.ts:201 already opens in the other direction.
- [ ] The focus deep link optionally scopes rather than just selects — accept `?scope=` (or make focus set focusId) so landing on a unit shows that unit's subtree, which is the 'extreme pivot' the owner is asking for.
- [ ] The same pivot is reachable from the area page for a non-graph user: a 'show only this unit' state that filters the graph's node set by unit membership rather than by node type (GraphSettings has hiddenTypes but no scope — lib/graphSettings.ts).

---

<a id="area-7"></a>

## AREA-7 · Owner question 6, answered: a master equipment list can never be filed into operating areas — the CSV importer has no unit or site-code column, and the codebook has no tag→unit decoder to recover one

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/assets/AssetCsvImportModal.tsx:22-27`, `components/assets/AssetCsvImportModal.tsx:124-134`, `lib/assetCategorize.ts:48-63`, `lib/codebook.ts:149-160`, `app/(protected)/admin/assets/page.tsx:969-1085`

**Mechanism.** The importer's field map is literally four entries: `const CANONICAL_FIELDS = [{key:"tag"…},{key:"description"},{key:"location"},{key:"type"}]` (AssetCsvImportModal.tsx:22-27), and the commit call is `createAsset({ orgId, tag, description, location, typeId, createdBy })` (:130-133) — `unitCode` and `code` are accepted by createAsset (lib/assets.ts:172-181) but never passed. So every imported row lands with unit_code NULL and code NULL. The recovery path cannot close that gap: `planCategorization` files an asset to a unit only via `if (!a.unit_code && a.code) { const decoded = codeToTag(a.code, book); if (decoded?.unitCode) …}` (assetCategorize.ts:51-56) — it needs the site code the import never wrote. And there is no function anywhere that derives a unit from a tag alone: `tagToCode(tag, unitCode, book)` opens with `if (!unitCode) return null` (codebook.ts:150), and `typeForTag` (codebook.ts:132-144) returns an equipment TYPE, never a unit. This is exactly the owner's split: the ID decoder does put the list in the right CATEGORY, and cannot put it in the right AREA.

**Failure scenario.** A 3,000-row master equipment list is imported. The Auto-categorize banner correctly creates Exchangers/Pumps/Vessels from codebook prefixes and reports `0 filed to their operating area from site codes` (UnitOpsPanels.tsx:65 renders filedToUnits). All 3,000 assets sit under the amber 'No unit assigned' card (page.tsx:614-624). The only remedy is UnassignedAssignPanel, which renders `const shown = assets.slice(0, 50)` with one dropdown per asset (page.tsx:1027, 1038-1058) — 60 screens of manual triage, and the panel offers no way to bulk-assign by pattern, by prefix, or by pasted mapping.

**Evidence.**

```
components/assets/AssetCsvImportModal.tsx:22-27 — the four-field CANONICAL_FIELDS with no unit/code. :130-133 — `await createAsset({ orgId, tag, description, location, typeId, createdBy: actorUserId });`. lib/assetCategorize.ts:51 — `if (!a.unit_code && a.code) {` — the unit-filing branch is unreachable for imported rows. lib/codebook.ts:150 — `if (!unitCode) return null;`. app/(protected)/admin/assets/page.tsx:1027 — `const shown = assets.slice(0, 50);`
```

> **Verifier correction.** The narrow mechanism is confirmed; the 'can never be filed' framing is refuted by two paths the finding did not check. (1) UnassignedAssignPanel at app/(protected)/admin/assets/page.tsx:969-1090 is an automated recovery path: it runs `parseDrawingNumber(l.documentNumber ?? "", book)` over each unassigned asset's LINKED DOCUMENTS, takes the top-voted unit code, pre-selects it with evidence ('drawings say 20 (3 linked drawings)'), and on Assign writes unit_code plus a derived site code via tagToCode (:1015-1019) — per asset or 'Assign all N selected'. So a master list does get filed once its drawings are linked; what is missing is a tag-ONLY decoder. (2) lib/equipmentBridgeServer.ts:240-258 backfills unit_code (and code) onto matched assets from the drawing's decoded unit — exactly the owner's scenario 6 — subject to finding 4's gate. Severity drops to MEDIUM.

**Done when.**

- [ ] CANONICAL_FIELDS gains `unit` (matched against codebook unit code OR label) and `code` (site code), and commit passes them to createAsset; when only `code` is given the importer decodes the unit via codeToTag at import time.
- [ ] UnassignedAssignPanel gets a bulk path — assign-all-matching-prefix, or a paste-a-tag→unit mapping — instead of 50 dropdowns at a time.
- [ ] Importing a 3,000-row list with a unit column lands every asset on its operating-area card with no manual step.

---

<a id="area-8"></a>

## AREA-8 · The area's order-of-operations checklist is real state, but three of its four steps are satisfied by a single occurrence — and step 1 is satisfied by a folder name alone

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/assets/AreaKnowledgePanel.tsx:192-196`, `components/assets/AreaKnowledgePanel.tsx:314-349`, `components/assets/AreaKnowledgePanel.tsx:102-150`, `app/api/area/knowledge-status/route.ts:128-139`

**Mechanism.** The checklist is not decorative — every state derives from a live query — but its thresholds are 'at least one'. Step 1 ('File this area's drawings in Documents') resolves, when no library is bound, to `status.suggestions.some((s) => s.docCount > 0)` (AreaKnowledgePanel.tsx:195). `suggestions` is `suggestFoldersForUnit(unit, allFolders)` (knowledge-status route.ts:136) — a name/code heuristic over folder names (areaKnowledge.ts:39-52), and docCount is any AI-readable document in that folder's subtree. So a folder called 'Crude' holding one unrelated memo flips step 1 to a green tick reading 'done'. Step 3 ('Deep read the drawings') is `flowCount > 0` where flowCount counts confirmed process_flows touching the unit (AreaKnowledgePanel.tsx:108-114, 332); one hand-drawn flow marks the deep read complete across 400 unread P&IDs. Step 4 ('Link equipment files to assets') is `docLinkCount > 0` (:347) — one document_assets row anywhere in the area. Only step 2 (bound library + ≥1 source + no loss-drift) is a genuine state check (:191).

**Failure scenario.** An engineer sets up the Crude Unit: binds the library, draws one flow on the graph, and one drawing happens to carry a tag. All four steps show emerald ticks. The area page reads 'complete' while 380 P&IDs have never been read for flows and 890 of 900 assets have no document attached. The panel's own framing — 'each step shows its live state' (:247) — makes the tick more trustworthy than it is.

**Evidence.**

```
components/assets/AreaKnowledgePanel.tsx:192-196 — `const drawingsDone = status ? (status.boundLibrary ? status.counts.ready + status.counts.pending > 0 : status.suggestions.some((s) => s.docCount > 0)) : false;`. :332 — `state={status === null || flowCount === null ? "loading" : (flowCount > 0 ? "done" : "todo")}`. :347 — `state={… docLinkCount > 0 ? "done" : "todo"}`.
```

**Done when.**

- [ ] Steps carry coverage, not presence: step 3 shows flows-read-per-drawing (documents in the area's library with a process_flows source_document_id vs total), step 4 shows linked-assets / total-area-assets, and 'done' means a threshold a plant engineer would accept.
- [ ] Step 1's unbound state distinguishes 'a folder matching this area's name exists' from 'this area's drawings are filed' — the former is a suggestion, not completion.
- [ ] The step-3/4 counts are computed over the area's full asset set even when listAssets truncates (see the unbounded-query finding).

---

<a id="area-9"></a>

## AREA-9 · The whole Operating Areas surface loads assets with an unbounded query and no pagination, so on a large plant every unit count, unit card, and area checklist silently describes a truncated registry

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/assets.ts:117-134`, `app/(protected)/admin/assets/page.tsx:114-118`, `app/(protected)/admin/assets/page.tsx:161-247`, `components/assets/AreaKnowledgePanel.tsx:116-131`

**Mechanism.** `listAssets` builds `supabase.from("assets").select("*").eq("org_id", …)` and finishes with `.order("tag", { ascending: true })` — no `.range()`, no `.limit()`, no follow-up page (lib/assets.ts:123-133). PostgREST as Supabase configures it caps a response at a fixed max-rows (conventionally 1000) and returns the truncated page without error, and this codebase behaves everywhere else as if that cap is real: /api/area/knowledge-status pages documents in `range(from, from + 999)` windows (route.ts:75-96), AreaKnowledgePanel pages document_assets in 1000-row windows (AreaKnowledgePanel.tsx:123-129), knowledge-status pages kdocs the same way (:153-162). I could not confirm the configured value from the repo — there is no supabase/config.toml — hence SUSPECTED. Everything on the page derives from that one array: `unitCounts` (page.tsx:162-170), `unitSummaries` (:216-235), `unknownUnits` (:240-247), the unassigned card, and `areaAssetIds` (:261-266), which is what AreaKnowledgePanel counts linked documents over — under a comment that claims the opposite: 'Chunked over EVERY asset (no 1,000-asset display cap)' (AreaKnowledgePanel.tsx:117).

**Failure scenario.** A 4,000-asset refinery opens Operating areas. The Crude Unit card says '312 assets' when it holds 900; the 'No unit assigned' card understates the backlog; the setup navigator's counts (which query with `count: 'exact', head: true` and are therefore correct — setup/page.tsx:56-64) disagree with the page they link to; and the area's step-3 checklist counts linked documents over roughly a quarter of the unit's equipment. Nothing on screen says 'showing the first N'.

**Evidence.**

```
lib/assets.ts:123-133 — `let q = supabase.from("assets").select("*").eq("org_id", params.orgId); … const { data, error } = await q.order("tag", { ascending: true });` with no range/limit. Contrast components/assets/AreaKnowledgePanel.tsx:128 — `if (!links || links.length < 1000 || from >= 20000) break;` — the same file pages defensively against exactly this cap.
```

**Done when.**

- [ ] listAssets pages in 1000-row windows the way the rest of the codebase does, or takes an explicit range and the page loads all pages before computing counts.
- [ ] Unit cards and the unassigned card are proven correct against a >2,000-asset org, or the page states the truncation.
- [ ] AreaKnowledgePanel.tsx:117's 'no 1,000-asset display cap' comment is true of its input, not just of its own loop.

---

<a id="area-10"></a>

## AREA-10 · Two independent, simultaneously live 'unit' models — and the columns the graph reads for one of them are never written by any code path

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260606_operational_entity_graph.sql:52-70`, `supabase/migrations/20260606_operational_entity_graph.sql:106-116`, `app/(protected)/admin/scope/page.tsx:126`, `lib/orgGraph.ts:190-201`, `lib/orgGraph.ts:253-259`, `app/(protected)/graph/page.tsx:318-324`

**Mechanism.** The app ships two unrelated hierarchies both called units. (1) `plants → units → systems` tables (20260606_operational_entity_graph.sql:32-95) edited at /admin/scope — sidebar label 'Operational scope' (Sidebar.tsx:261) — with `assets.unit_id` and `documents.unit_id` FKs (20260606:106-116). (2) Site Codebook units (codebook_entries kind='unit', 20260928_site_codebook.sql) browsed at /admin/assets — sidebar label 'Operating areas' (Sidebar.tsx:230) — with `assets.unit_code`. orgGraph emits BOTH as `type: "unit"`: `nodes.set(`unit:${u.id}`, { type: "unit", …, href: "/admin/scope" })` at :190-194 and `nodes.set(`cbunit:${u.code}`, { type: "unit", …, href: `/admin/assets?unit=…` })` at :198-202. But nothing writes the FK side: `assets.unit_id` appears in exactly three places in the whole codebase — the Asset type (lib/assets.ts:36), the orgGraph select (:115) and the orgGraph edge (:256) — createAsset/updateAsset expose only `unitCode`/`code` (lib/assets.ts:172-206), and `documents.unit_id` is settable only through `createDocument(input.unitId)` (lib/documentLifecycle/common.ts:181) which no caller ever supplies (grep for `unitId` across app/ and components/documents/ returns only /admin/scope's createSystem). Legacy unit and plant nodes therefore survive pruning solely on the unit→plant edge (:253) and float detached from all equipment and paper (:322 only deletes degree-0 grouping nodes). The two models also collide in Connect mode: `unitCode(n)` returns `n.sub` for a `unit:` node (graph/page.tsx:320-322), i.e. the units-table code like 'U100', which is then written into process_flows.from_ref as if it were a codebook unit code.

**Failure scenario.** An admin does the sensible-looking thing and fills in /admin/scope (Baton Rouge → Crude Unit → Overhead System), then opens the graph and sees a 'Crude Unit' node with zero equipment attached, next to a second 'Crude Unit' node that has all of it. Connecting the two legacy unit nodes writes `process_flows(from_kind='unit', from_ref='U100')`; orgGraph maps that to `cbunit:U100`, `addEdge` drops it because `!nodes.has(a)` (orgGraph.ts:174), so the flow is invisible on the graph forever — but it persists in the DB, renders as 'Unit U100' in FlowPanel's endpointLabel (UnitOpsPanels.tsx:148), links to an operating area that does not exist, and lands in the AI reader's `settled` set.

**Evidence.**

```
lib/orgGraph.ts:190-194 and :198-202 — two node families, both `type: "unit"`, hrefs '/admin/scope' vs '/admin/assets?unit=…'. :255-256 — `if (a.unit_code) addEdge(…cbunit…); if (a.unit_id) addEdge(…unit:…);`. app/(protected)/graph/page.tsx:320-322 — `n.id.startsWith("cbunit:") ? n.id.slice(7) : n.id.startsWith("unit:") ? (n.sub ?? null) : null`. lib/orgGraph.ts:174 — `if (a === b || !nodes.has(a) || !nodes.has(b)) return;`.
```

> **Verifier correction.** Two evidence items are wrong and must not be carried forward. (a) The legacy unit node's href is NOT '/admin/scope' — lib/orgGraph.ts:189-193 sets `href: "/admin/assets"`; '/admin/scope' is the PLANT node's href at :185-188. The finding's evidence line ('hrefs /admin/scope vs /admin/assets?unit=…') is false as written; both unit families point into /admin/assets, which arguably worsens the collision but is not what was claimed. (b) assets.unit_id does not appear in 'exactly three places': lib/search.ts:262 and :283 also filter assets on it inside searchAssets (a param no caller supplies — globalSearch.ts:38 passes only orgId/query/limit). Severity corrected to MEDIUM: this is a coherence/comprehensiveness defect (floating legacy nodes, a possible bogus flow ref), not security or data loss.

**Done when.**

- [ ] A decision is made and executed: either /admin/scope and the units/plants tables are retired (as the Operating Areas 3D feature already was in 54f60fe) and the graph stops reading assets.unit_id / documents.unit_id, or codebook units are backed by the units table so there is one unit identity.
- [ ] Until then, orgGraph must not emit two node families under the same type label, and Connect mode must refuse a `unit:` endpoint rather than writing a units-table code into process_flows.from_ref.
- [ ] No process_flows row can be created whose unit ref does not resolve to a codebook_entries row.

---

<a id="area-11"></a>

## AREA-11 · assets.code and assets.unit_code can permanently contradict each other, and every automated writer is a fill-blanks-only path that will never reconcile them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/assets/page.tsx:1309-1314`, `app/(protected)/admin/assets/page.tsx:1011-1018`, `lib/equipmentBridgeServer.ts:240-258`, `lib/assetCategorize.ts:51-56`

**Mechanism.** The site code carries the unit inside it — codeToTag('2530.22') decodes to unit '25' (codebook.ts:165-183) — so `code` and `unit_code` are two spellings of the same fact. Every writer refuses to touch a non-blank value. The edit drawer's derivation opens `if (asset?.code) return; // existing explicit code: never overwrite silently` (page.tsx:1310), so changing an asset's operating area in the drawer leaves the old site code intact. UnassignedAssignPanel writes `code: r.asset.code ?? tagToCode(r.asset.tag, r.unitCode, book) ?? null` (page.tsx:1015) — again preserving a pre-existing code that may name a different unit. The Bridge's backfill is explicitly NULL-only: it selects `.in("id", ids).is("unit_code", null)` and updates with `.is("unit_code", null)` (equipmentBridgeServer.ts:245, 253), and only sets code `if (!blank.get(id) && s.code)`. planCategorization likewise only acts when `!a.unit_code` (assetCategorize.ts:51). Nothing anywhere compares the two and reports a conflict — the Facility Setup navigator counts `unitless` assets (setup/page.tsx:81) but never mismatched ones.

**Failure scenario.** E-22 is imported with code 2530.22 (unit 25, DHT). Someone assigns it to the Crude Unit in the drawer. The registry row now reads unit_code='20', code='2530.22'. It appears on the Crude Unit card and in Crude's asset list; the site code stamped on its QR label and printed on every doc pack says DHT; the graph draws asset→cbunit:20; the Bridge, seeing unit_code non-null, will never correct it. Both surfaces believe they are right and neither can see the other's claim.

**Evidence.**

```
app/(protected)/admin/assets/page.tsx:1310 — `if (asset?.code) return; // existing explicit code: never overwrite silently`. :1015 — `code: r.asset.code ?? tagToCode(r.asset.tag, r.unitCode, book) ?? null,`. lib/equipmentBridgeServer.ts:245 — `.select("id, code").in("id", ids).is("unit_code", null);`
```

**Done when.**

- [ ] A pure helper decodes assets.code and compares its unit against assets.unit_code, and the Operating Areas page shows a banner listing conflicts with a one-click reconcile (keep the code, or keep the filing and re-derive the code).
- [ ] The edit drawer, when the user changes unitCode on an asset whose existing code decodes to a different unit, says so before saving instead of silently keeping both.
- [ ] The Facility Setup navigator's registry stage counts mismatches alongside `unitless`.

---
