# 07 · The graph data model

**14 findings** — 4 HIGH · 10 MEDIUM.

Every edge, every cap, and what the graph does not model. **Your comprehensiveness question.**

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| documents_acl_select — a RESTRICTIVE SELECT policy calling node_visible(visibility, acl_index, org_id), with a fail-safe that treats normal/NULL visibility as open and always admits Admin/DocCtrl | `supabase/migrations/20260708_acl_rls_enforcement.sql:41-86` | This is why the client-side buildOrgGraph does not leak restricted documents despite pulling document_assets, entity_mentions, document_supersessions and document_related_resources through org-member-all policies: the restricted document never becomes a node, and addEdge's endpoint guard drops its edges. Any move of assembly to a server route under supabaseAdmin MUST reimplement node_visible() per-caller or this protection is lost silently. |
| projects_visibility_select — the equivalent restrictive policy on projects | `supabase/migrations/20260906_projects_hardening.sql:72-73, supabase/migrations/20260913_projects_rls_recursion_fix.sql:62` | Project nodes are ACL-filtered on the same principle, so the graph never offers a click-through to a project the viewer cannot open. |
| addEdge's endpoint-existence guard plus type-aware dedup set | `lib/orgGraph.ts:173-181` | `if (a === b \|\| !nodes.has(a) \|\| !nodes.has(b)) return;` is what turns every cap, ACL filter and missing codebook entry into a missing edge rather than a dangling reference or a crash. It is load-bearing for the whole degradation story and must survive any refactor — but it is also the exact line that makes the losses silent, so instrumentation belongs here, not a rewrite. |
| pageRows' narrow missing-table tolerance (42P01 / 'does not exist') with a rethrow for everything else | `lib/orgGraph.ts:85-87` | This is the CORRECT version of the error-tolerance idiom, and the model that `optional()` at line 152 should be rewritten to follow. A pre-migration org gets a smaller graph; a real failure still surfaces. |
| Multi-sheet document label disambiguation — when a document_number repeats, the sheet number (or title) is carried into the node label | `lib/orgGraph.ts:229-250` | `Sh 3 of 12` in the label is already the sheet-awareness hook the owner's per-sheet question needs, and documents.sheet_number/sheet_total are already selected and in DocRow. A document↔sheet↔equipment edge would build on existing, working code rather than new schema. |
| knowledge_page_entities already stores tag + page + x + y per document, and knowledge_line_traces exists alongside it | `supabase/migrations/20260921_drawing_entities.sql:20-35, supabase/migrations/20260924_entity_positions.sql:23-32` | The substrate for "which equipment is on which sheet, and where on the sheet" is already persisted with positions and a (document_id, page, tag) index. Nothing new needs extracting — it needs a server-side reader, because the table is REVOKEd from `authenticated`. |
| computeInsights is pure, I/O-free and unit-tested, with a correct iterative Tarjan bridge finder that tracks subtree sizes to report both side counts | `lib/graphInsights.ts:111-159, lib/__tests__/graphInsights.test.ts` | The algorithm itself is right — disc/low/subtree bookkeeping, single-parent-edge skip, sideA = compSize - childSide. The defects found are in what is fed to it (the filtered view) and two lookup-table bugs (REGION_ANCHOR_ORDER, multiplicity). Fixing those does not require touching the traversal. |
| The unmappedMentions counter and its explanatory truncation — the module counts mentions it could not attach and says so rather than dropping them | `lib/orgGraph.ts:299-315` | This is precisely the instrumentation pattern every other silent loss in the file needs. The intent is exemplary; only the 5000-row mirror cap corrupts the message it produces. |
| The mention engine's idempotent replace-per-document write, which preserves is_explicit human pins across re-index | `lib/mentionIndexer.ts:124-142` | `.delete().eq("knowledge_document_id", …).eq("is_explicit", false)` before upsert means a re-index can never stack duplicates or erase a human decision — the graph's mention edges can be safely rebuilt at any time. |
| /api/graph/mentions reports `incomplete` when it runs out of wall clock instead of pretending a truncated pass was the whole plant | `app/api/graph/mentions/route.ts:20-23, lib/mentionIndexer.ts:177-187` | A 45s budget with an explicit incomplete flag and a resumable, idempotent per-document unit of work. This is the honesty standard the assembly layer's truncation reporting should be held to. |


---


<a id="gm-1"></a>

## GM-1 · All four Insights lenses are computed on the FILTERED view, so orphan/hub/bridge counts change every time you tap a lens — and the orphan copy is false under three of the four

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:239-242`, `app/(protected)/graph/page.tsx:151-180`, `app/(protected)/graph/page.tsx:428-433`, `lib/graphInsights.ts:43`, `lib/graphInsights.ts:67-69`, `app/(protected)/graph/page.tsx:614-616`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Mechanism confirmed exactly, including the badge at page.tsx:581-585 rendering `insights.orphans.length` unqualified. Downgraded from HIGH because view-scoped analysis is a defensible design (the empty-state copy at page.tsx:610 already says 'everything SHOWN is tied into the web') — the actual defect is the non-empty branch's copy asserting a plant-wide fact and an unlabelled count, i.e. misleading UI rather than broken analysis.

**Mechanism.** `computeInsights` is fed `view`, not `graph`:

```
const insights = React.useMemo(
  () => (view ? computeInsights(view.nodes, view.edges) : null),
  [view],
);
```

`view` (page.tsx:151-180) has already removed every node whose type is in `settings.hiddenTypes`, and then removed every edge with a missing endpoint. The lenses (page.tsx:428-433) are pure type-subtraction presets: `process` hides `["document","library","project","plot"]`, `equipment` hides `["unit","plant","project","library"]`, `documents` hides `["asset","unit","plant","plot"]`. In graphInsights an orphan is simply a document/asset with no surviving edge: `nodes.filter((n) => ORPHANABLE.has(n.type) && !degree.has(n.id))`.

**Failure scenario.** An engineer taps the "Equipment ↔ Docs" lens, which hides unit and plant. Every piece of equipment whose only tie is `asset → cbunit` (which, per finding 1, is MOST equipment) instantly becomes an orphan. The red badge on the Insights button jumps from 12 to 1,800, and the panel's own copy asserts the opposite of the truth: "Floating with no equipment, unit, project or link — no context yet" (page.tsx:615) — while those assets are in fact all correctly assigned to a unit that the lens just hid. Tap "Everything" and the number collapses again. In a PSM shop the orphan count is read as a compliance metric; here it is a function of which chip you last pressed.

**Evidence.**

```
page.tsx:240 passes `view.nodes, view.edges`. page.tsx:153-155: `const typeOk = (t: GraphNodeType) => !settings.hiddenTypes.includes(t) && (t !== "library" || settings.showLibraryEdges); let nodes = graph.nodes.filter((n) => typeOk(n.type));`. graphInsights.ts:68 defines orphan as absence from the degree map built only from `web` (contextEdges of the passed-in edges).
```

**Chain reaction.** Hubs and bridges have the same defect but read as less alarming. The Bridges panel's "Only link between clusters of N and M nodes" (page.tsx:673) is likewise a statement about the current filter, presented as a statement about the plant.

> **Verifier correction.** One partial mitigation exists and should be noted rather than treated as a fix: page.tsx:597 forces `hideUnlinked: false` when the Orphans tab is clicked, so that one filter cannot manufacture orphans — but it does nothing about hiddenTypes, focus depth, or the lens presets, which are the mechanism here. Note also that the copy claim is read off the literal JSX string and the data path, not from running the app; the string and the filter are both in code, so it holds, but no one observed the rendered panel.

**Done when.**

- [ ] computeInsights runs on the full assembled graph (graph.nodes/graph.edges) and the panel filters the RESULT for display, or the panel labels every count with the lens it was computed under
- [ ] The orphan copy states the real predicate ("no visible link in this view") whenever hiddenTypes is non-empty
- [ ] A test asserts that hiding node types does not change the orphan count for a node that still has a hidden-type edge

---

<a id="gm-2"></a>

## GM-2 · Documents and equipment attach to two DIFFERENT unit node families that no edge ever joins — assets.unit_id is dead code, never written by any path

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:254-261`, `lib/orgGraph.ts:190-203`, `lib/assets.ts:196-213`, `supabase/migrations/20260928_site_codebook.sql:78`, `supabase/migrations/20260606_operational_entity_graph.sql:113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The 'never written' half is confirmed by repo-wide search: `createAsset` (lib/assets.ts:183-203) inserts only org_id/tag/tag_normalized/type_id/description/location/library_id/created_by/updated_by plus unit_code and code; `updateAsset` (assets.ts:206) whitelists `"tag"|"type_id"|"description"|"location"|"library_id"|"archived"|"cover_photo_id"|"unit_code"|"code"` — no unit_id. No migration backfills it either (only the ADD COLUMN and its index). Codebook units come from `codebook_entries` (20260928_site_codebook.sql), a different table entirely, so the two violet nodes are real.

**Mechanism.** Assembly creates two disjoint families of node for the same real-world concept. `units` rows become `unit:<uuid>` (orgGraph.ts:190-195); Site Codebook units become `cbunit:<code>` (orgGraph.ts:198-203). The edges are then wired as:

```
for (const u of units) addEdge(`unit:${u.id}`, `plant:${u.plant_id}`, "unit");
for (const a of assets) {
  if (a.unit_code) addEdge(`asset:${a.id}`, `cbunit:${a.unit_code}`, "unit");
  if (a.unit_id)   addEdge(`asset:${a.id}`, `unit:${a.unit_id}`,     "unit");
}
for (const d of docs) {
  if (d.unit_id) addEdge(`doc:${d.id}`, `unit:${d.unit_id}`, "unit");
```

Nothing anywhere joins `cbunit:<code>` to `unit:<uuid>`, and nothing joins `cbunit:` to `plant:`. The only thing that could reconcile them is `assets.unit_id` — and no code path writes it. `lib/assets.ts:197` inserts `{ ...base, unit_code: input.unitCode ?? null, code: input.code ?? null }`; `lib/assets.ts:206` types the update patch as `Partial<Pick<Asset, "tag"|"type_id"|"description"|"location"|"library_id"|"archived"|"cover_photo_id"|"unit_code"|"code">>` — `unit_id` is not an allowed key. The Bridge (lib/equipmentBridgeServer.ts:219-253) writes `unit_code` only. A repo-wide search for the object-literal write form `unit_id\s*:` returns writes for documents (lib/documentLifecycle/common.ts:181), plot_plans (lib/plotPlans.ts:78) and systems (lib/operationalGraph.ts:189) — never assets.

**Failure scenario.** An org runs the Site Codebook (assets get unit_code="20") and files drawings with documents.unit_id pointing at a `units` row also named Crude Unit. On /graph the map draws TWO violet unit nodes both labelled Crude Unit: one (`cbunit:20`) surrounded by 400 pieces of equipment and zero documents, one (`unit:<uuid>`) surrounded by 60 documents and zero equipment. There is no path between them at any depth, so Connection-path (page.tsx:252-266) reports "Nothing connects … within 8 hops", Focus-mode on either shows half the unit, and no filter, lens, or depth setting can ever produce the owner's "crude unit: all of this goes here" view. Line 256 (`if (a.unit_id)`) is unreachable in production data, so the operational `unit:`/`plant:` hierarchy contains no equipment at all.

**Evidence.**

```
orgGraph.ts:255-256 adds asset→cbunit and asset→unit; orgGraph.ts:259 adds doc→unit only. Schema proves the split: `ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_code TEXT;` (20260928_site_codebook.sql:78) vs `ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES units(id)` (20260606_operational_entity_graph.sql:113). Two differently-shaped searches confirmed no writer: `grep -rn 'unit_id' lib components app` and `Grep 'unit_id\s*:' **/*.{ts,tsx}` — neither returns an assets write.
```

**Chain reaction.** This is the root cause of the owner's question 3 ("no way to do an extreme pivot"). A unit scope filter cannot be built on top of this data model, because the unit a document belongs to and the unit a piece of equipment belongs to are different primary keys in different tables with no mapping row. Any scope feature must first choose one unit identity and backfill the other.

> **Verifier correction.** Severity CRITICAL is overstated. This is a completeness defect in a read-only visualization, not a data-integrity or authorization failure, and the headline is too broad: documents and equipment ARE joined directly by `tag` edges (orgGraph.ts:262, from document_assets) and `mention` edges (:304). What is actually broken is unit-MEDIATED joining — a document scoped by documents.unit_id lands on `unit:<uuid>` while its equipment lands on `cbunit:<code>`, so neither the plant hierarchy nor the codebook unit acts as a shared neighborhood, and the `unit`→`plant` chain never reaches any asset.

**Done when.**

- [ ] A single unit identity is canonical for both documents and assets, or a persisted mapping row (units.codebook_code, or assets.unit_id backfilled from unit_code) joins them
- [ ] buildOrgGraph emits at most one node per real unit, or emits an edge between cbunit:<code> and unit:<uuid> when they denote the same unit
- [ ] A test asserts that a document with unit_id and an asset with the corresponding unit_code land within 2 hops of each other in the assembled graph
- [ ] lib/assets.ts createAsset/updateAsset either write unit_id or the dead `if (a.unit_id)` branch at orgGraph.ts:256 is removed

---

<a id="gm-3"></a>

## GM-3 · Node caps silently sever edges, and the truncation notice that fires ("densest web shown") is factually false — edge pagination has no ORDER BY at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:59-62`, `lib/orgGraph.ts:74-94`, `lib/orgGraph.ts:114-117`, `lib/orgGraph.ts:164-167`, `lib/orgGraph.ts:173-181`, `lib/orgGraph.ts:306`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Both halves are true: 'densest web shown' is a fabrication over an unordered PostgREST range, and edges to nodes cut by DOC_CAP/ASSET_CAP vanish uncounted. Downgraded from HIGH because the page does warn about the node caps themselves (page.tsx:737-741 renders 'Showing the 1500 most recently updated documents' / 'Showing the first 2000 equipment items'), so the user is told the map is partial — the defect is that the description of HOW it is partial is false.

**Mechanism.** Nodes are capped independently of edges. Documents: `.order("updated_at", …).limit(DOC_CAP)` = 1500. Assets: `.eq("archived", false).limit(ASSET_CAP)` = 2000 with NO `.order()` at all. Join tables are pulled to EDGE_CAP=8000 org-wide. `addEdge` then drops anything whose endpoint is missing:

```
const addEdge = (a: string, b: string, type: GraphEdgeType) => {
  if (a === b || !nodes.has(a) || !nodes.has(b)) return;
```

So every `document_assets` / `entity_mentions` / `process_flows` row touching document #1501 or asset #2001 vanishes with no counter, no note, and no error. Separately, `pageRows` paginates with `.range(from, …)` and no `.order()`:

```
const { data, error } = await supabase
  .from(table).select(select)
  .eq("org_id", orgId)
  .range(from, Math.min(from + EDGE_PAGE, cap) - 1);
```

An unordered LIMIT/OFFSET in Postgres has no stable row order between the eight round trips, so pages can overlap and skip. Duplicates are absorbed by `edgeSeen`; skipped rows are simply lost. The notices that DO fire assert something the code never computes: `truncations.push("Equipment-tag links capped — densest web shown.")` (line 166) and `"Mention links capped — densest web shown."` (line 306). Nothing sorts by degree or density anywhere in the file — these are the first ~8000 rows in whatever order the planner returned. Same for "Showing the first 2000 equipment items" (line 165): with no ORDER BY there is no "first".

**Failure scenario.** A refinery with 18,000 controlled drawings and 24,000 tagged items opens /graph. It sees 1500 documents (the most recently touched — i.e. whatever was edited last week, not the plant), 2000 arbitrarily-chosen assets, and roughly 8000 of perhaps 300,000 tag links. The Insights panel then reports "Orphans: 1400" — because those documents' assets were cut, not because the documents are uncontextualised. A PSM engineer reads that as 1400 uncontrolled files. Two page loads on the same day can also show two different sets of 2000 assets, because the asset query is unordered.

**Evidence.**

```
lib/orgGraph.ts:59-62 `const DOC_CAP = 1500; const ASSET_CAP = 2000; const EDGE_PAGE = 1000; const EDGE_CAP = 8000;`. lib/orgGraph.ts:114-117 shows the assets query with `.limit(ASSET_CAP)` and no `.order(...)`. lib/orgGraph.ts:174 is the silent edge-drop guard. Grep of `truncations\.push|\.capped` in lib/orgGraph.ts returns exactly six lines (164, 165, 166, 167, 306, 311) — none of which counts dropped edges.
```

**Chain reaction.** Every downstream analysis inherits the loss: computeInsights runs on the truncated view, so orphans, hubs, bridges and regions are all computed against a plant-sized hole. The header claim at lib/orgGraph.ts:17-18 ("Every list is capped and the truncation is reported, never silent") is the contract this violates.

> **Verifier correction.** One nuance worth carrying: pageRows early-exits at :91 (`if (batch.length < EDGE_PAGE) return { rows, capped: false }`), so the unordered-OFFSET overlap/skip hazard only bites join tables holding more than 1000 rows, and the node-cap severing only bites past 1500 documents / 2000 assets. Both thresholds are realistic for a plant, so the finding holds, but it is a cap-scale defect, not one that fires on a small org.

**Done when.**

- [ ] Edges are counted before and after the addEdge existence guard, and a truncation reports the dropped count ("N links reference equipment/documents outside this view")
- [ ] Both `.range()` pagination in pageRows and the assets `.limit()` carry an explicit `.order()` on a unique column so paging is stable and "first N" is meaningful
- [ ] The "densest web shown" strings are either removed or backed by an actual density-ordered query
- [ ] A test asserts that an org exceeding ASSET_CAP produces a truncation naming the number of severed edges

---

<a id="gm-4"></a>

## GM-4 · optional() swallows every query error — a failed assets, units, plants, projects, flows or plot-plan read renders a silently smaller graph with no error and no truncation

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:149-162`, `lib/orgGraph.ts:216-221`, `lib/orgGraph.ts:275-280`, `lib/orgGraph.ts:296-298`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The core claim holds for assets/units/plants/projects/plot-plans, and the contrast is stark against orgGraph.ts:86-87 where pageRows narrows to `if (error.code === "42P01" || /does not exist/i.test(error.message)) return { rows, capped: false }; throw new Error(error.message);`. Corrected because the title is wrong about FLOWS: process_flows goes through pageRows (:133-134), which THROWS on a real error rather than swallowing it. Severity lowered accordingly — the swallowed set is smaller than claimed and the surface is an advisory map.

**Mechanism.** Only documents and libraries are treated as fatal:

```
for (const r of [docsRes, libsRes]) {
  if (r.error) throw new Error(r.error.message);
}
const optional = <T,>(res: { data: unknown; error: { message: string } | null }): T[] => {
  if (res.error) return [];
  return (res.data as T[]) ?? [];
};
```

The comment above it justifies this as tolerating a missing migration ("an org that never ran that feature's migration gets a smaller graph"), but the predicate is `if (res.error)` — ANY error, not just 42P01. `pageRows` gets this right (it narrows to `error.code === "42P01" || /does not exist/i.test(error.message)` at line 86 and rethrows otherwise); `optional` does not. Assets, units, plants, projects, plot_plans and knowledge_documents all route through `optional`.

**Failure scenario.** On a large org the assets query (`.eq(org_id).eq(archived,false).limit(2000)`) hits a PostgREST statement timeout, or a transient 503, or a JWT that expired mid-flight. `optional(assetsRes)` returns `[]`. The page renders a complete-looking, error-free document graph containing zero equipment, zero tag edges, zero mention edges, zero flows, and no truncation notice. The user's honest conclusion is "the registry isn't linked to anything" — and the Insights panel confirms it by reporting every document as an orphan. The same failure on `plot_plans` silently deletes the entire spatial layer.

**Evidence.**

```
lib/orgGraph.ts:152-155 quoted above. Contrast with the correctly narrowed handler in pageRows, lib/orgGraph.ts:85-87: `if (error.code === "42P01" || /does not exist/i.test(error.message)) return { rows, capped: false }; throw new Error(error.message);`
```

**Done when.**

- [ ] optional() narrows to the missing-table codes exactly as pageRows does, and rethrows or records a truncation for any other error
- [ ] Every swallowed error appends a visible note ("Equipment could not be loaded — the map is incomplete") to OrgGraph.truncations
- [ ] A test injects a non-42P01 error on the assets query and asserts the graph either throws or reports the gap

---

<a id="gm-5"></a>

## GM-5 · Bridge detection systematically misses the most common real bridge, because a doc↔asset pair carrying both a tag edge and a mention edge is treated as a redundant parallel connection

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/graphInsights.ts:79-84`, `lib/graphInsights.ts:142-143`, `lib/orgGraph.ts:262`, `lib/orgGraph.ts:300-305`, `lib/mentionIndexer.ts:104-142`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. lib/mentionIndexer.ts:104-120 writes an entity_mentions row for every asset it finds in the text with no exclusion for already-tagged pairs, so a Bridge-tagged drawing that also names the tag reliably lands at multiplicity 2 and is silently disqualified — while page.tsx:654-656 prints 'No single-thread bridges — every big neighbourhood has redundant connections.'

**Mechanism.** Multiplicity is counted by node PAIR, ignoring edge type:

```
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const multiplicity = new Map<string, number>();
for (const e of web) {
  const k = pairKey(e.a, e.b);
  multiplicity.set(k, (multiplicity.get(k) ?? 0) + 1);
}
```

and a candidate bridge is rejected unless multiplicity is exactly 1:

```
if (low.get(u)! > disc.get(parent)! && (multiplicity.get(pairKey(parent, u)) ?? 0) === 1) {
  bridgePairs.push({ aId: parent, bId: u, childSide: subtree.get(u)! });
}
```

But orgGraph deliberately emits BOTH a `tag` edge (from document_assets, line 262) and a `mention` edge (from entity_mentions, line 304) for the same doc/asset pair — `addEdge`'s dedup key includes the type (`${a}|${b}|${type}`, line 175), so both survive. The module header at orgGraph.ts:291-294 states this is intentional: "Drawn as their own edge type rather than folded into 'tag' … Seeing them separately is how you notice a standard that governs a vessel nobody ever tagged it to." The mention indexer writes exactly these pairs for every controlled document that is mirrored into knowledge (mentionIndexer.ts:108-120 sets both `document_id: mirrorDocumentId` and `asset_id`).

**Failure scenario.** Drawing PID-4402 is the only thing tying the Unit 44 cluster to the Unit 20 cluster, via asset E-2201. Because the Bridge tagged it (document_assets) AND the mention engine found "E-2201" in its text (entity_mentions), the pair has multiplicity 2 and is skipped. The Bridges panel reports "No single-thread bridges — every big neighbourhood has redundant connections" (page.tsx:655) while the single-thread bridge sits there in plain view. The better an org's indexing, the more bridges it hides.

**Evidence.**

```
lib/graphInsights.ts:79-84 and 142 quoted above. lib/orgGraph.ts:175: `const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;` — type is part of the dedup key, so parallel edges of different types are both kept. lib/orgGraph.ts:262 and 304 are the two emitters.
```

**Chain reaction.** The panel's empty state is affirmatively reassuring ("every big neighbourhood has redundant connections"), so a suppressed bridge reads as a clean bill of health rather than an absence of analysis.

> **Verifier correction.** Downgrade the verification, not the finding. "Systematically misses the MOST COMMON real bridge" is a frequency claim about production data that nothing in the repo establishes — it needs a doc/asset pair that is simultaneously both edge types AND a genuine articulation edge between two clusters of ≥4 nodes each (graphInsights.ts:157 minBridgeSide). What is code-provable is the direction of the error: the guard can only suppress true bridges (false negatives), never invent false ones.

**Done when.**

- [ ] Multiplicity counts distinct RELATIONSHIPS, not distinct edge types — e.g. collapse tag+mention between the same pair to one before counting
- [ ] A test builds two clusters joined only by a doc/asset pair carrying both a tag and a mention edge and asserts a bridge is reported
- [ ] The empty state distinguishes "no bridges found" from "bridge analysis suppressed"

---

<a id="gm-6"></a>

## GM-6 · Insights are ACL-dependent but presented as facts about the plant: the same map yields different orphan, hub and bridge answers for a controller and a viewer

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20260708_acl_rls_enforcement.sql:41-86`, `lib/orgGraph.ts:109-117`, `supabase/migrations/20260605_rls_policies_new_tables.sql:26-27`, `app/(protected)/graph/page.tsx:581-586`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a controller's document set is a strict superset of a viewer's, assets are identical for both, so orphan/hub/bridge output is viewer-relative by construction. Nothing on the page qualifies it — page.tsx:581-586 and 614-616 print the counts and 'no context yet' with no ACL caveat, and the truncation strip (737-741) carries only cap notices.

**Mechanism.** The documents read IS correctly ACL-filtered — `node_visible()` returns true unconditionally for Admin/DocCtrl (`IF v_role IN ('Admin','DocCtrl') THEN RETURN true;`) and otherwise requires an explicit allow grant, applied as `CREATE POLICY documents_acl_select ON documents AS RESTRICTIVE FOR SELECT USING (node_visible(visibility, acl_index, org_id));`. Assets, by contrast, are org-member-all (`assets_member_all`). So the asset side of the graph is identical for every member while the document side shrinks per viewer. Nothing in the assembly or the UI records that the document list was filtered, so the truncations array stays empty and the Insights badge (page.tsx:581-586) renders a bare count.

**Failure scenario.** A DocCtrl runs Insights and sees "Orphans: 12". A process engineer without grants on the restricted P&ID folder runs the same page and sees "Orphans: 340" — every asset whose only documents are restricted now reads as uncontextualised equipment. Neither number is labelled as viewer-relative, and neither user has any way to know the other sees something different. In a PSM audit, exporting the wrong one is a defensible-looking but wrong artefact.

**Evidence.**

```
20260708_acl_rls_enforcement.sql:57-61 (`SELECT role INTO v_role FROM org_members … IF v_role IN ('Admin','DocCtrl') THEN RETURN true;`) and :85-87 (the RESTRICTIVE policy). 20260605_rls_policies_new_tables.sql:26-27 creates `assets_member_all`. lib/orgGraph.ts:164-167 pushes truncations for caps only — nothing for ACL filtering.
```

**Chain reaction.** There is no data leak here — this is the ACL working — but the honesty contract the module sets for itself ("never silent") is not extended to the largest single cause of missing nodes for a non-controller.

> **Verifier correction.** Verification downgraded because the consequence is data-dependent and nobody ran the app: node_visible returns true immediately when `p_visibility IS NULL OR p_visibility = 'normal'` (20260708:52-55), so the per-role divergence only materializes for documents explicitly marked restricted. In an org with no restricted documents, every member's graph and insights are identical. The structural asymmetry (ACL on documents, none on assets, no disclosure in the UI) is confirmed; the claim about differing answers is conditional on restricted documents existing.

**Done when.**

- [ ] The graph reports when the viewer's ACL removed documents (a count is enough: "N documents are outside your access")
- [ ] Insights counts are labelled as viewer-scoped, or the compliance-facing orphan analysis is moved to a controller-only server route that sees everything
- [ ] A test compares assembled graphs for a controller and a granted-nothing member on the same org and asserts the difference is surfaced

---

<a id="gm-7"></a>

## GM-7 · Link proposals are drawn as document↔document unconditionally and swallow their own errors, so a failed or capped proposal read is indistinguishable from "no proposals"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:125-130`, `lib/linkProposals.ts:196-206`, `app/(protected)/graph/page.tsx:744-750`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The truncation/error half is real: 4000 is a hard silent cap, an error resolves to an empty array indistinguishable from 'no proposals', and the on-map chip reports the drawn count as if it were the queue. The 'drawn as document↔document unconditionally' half is REFUTED — both endpoint columns are NOT NULL FKs to `documents`, so the `doc:` prefix at page.tsx:128 is correct by schema, not an unchecked assumption. Impact is a misleading count on a map that links straight to the authoritative /admin/proposed-links queue, so LOW.

**Mechanism.** `listPendingPairs` caps at 4000 and returns `[]` on any error:

```
const { data, error } = await supabase
  .from("proposed_links").select("document_id, target_document_id, proposer")
  .eq("org_id", orgId).eq("status", "pending").limit(4000);
if (error) return [];
```

The page then hard-codes the `doc:` namespace for both endpoints and swallows the rejection too:

```
.then((pairs) => { setProposals(pairs.map((p) => ({ a: `doc:${p.a}`, b: `doc:${p.b}`, type: "proposed" as const }))); })
.catch(() => { if (alive) setProposals([]); });
```

Unlike `graph.truncations`, the proposals path has no truncation channel at all — the amber "N dashed connections awaiting review" chip (page.tsx:744-750) simply does not render, and the ghost edges do not appear.

**Failure scenario.** An org runs Find-connections and generates 9,000 pending proposals. 5,000 are silently invisible on the map with no chip, no count and no note; a reviewer working from the graph believes the queue is 4,000. If the proposed_links read fails outright (pre-migration, RLS, timeout) the map is identical to a healthy org with zero proposals. Additionally the hard-coded `doc:` prefix means any future proposal whose endpoint is an asset would be silently dropped by addEdge's endpoint guard rather than drawn.

**Evidence.**

```
lib/linkProposals.ts:200-204 quoted above (`.limit(4000)`, `if (error) return [];`). app/(protected)/graph/page.tsx:128 `setProposals(pairs.map((p) => ({ a: `doc:${p.a}`, b: `doc:${p.b}`, type: "proposed" as const })));` and :130 `.catch(() => { if (alive) setProposals([]); });`
```

> **Verifier correction.** The headline's first clause is REFUTED and should be dropped. Hardcoding the `doc:` namespace for both endpoints is CORRECT, not a defect: 20260807_link_proposals.sql:28-29 declares `document_id UUID NOT NULL REFERENCES documents(id)` and `target_document_id UUID NOT NULL REFERENCES documents(id)`, and the comment at :26-27 notes endpoints are stored smaller-id-first so A→B and B→A cannot both exist. proposed_links can only ever hold document pairs. What survives is solely the silent `if (error) return []` plus an uncounted 4000-row cap with no truncation channel.

**Done when.**

- [ ] listPendingPairs distinguishes error, capped and empty, and the page surfaces the first two
- [ ] The proposals count shown on the chip is the true pending count, not the drawn count
- [ ] Proposal endpoints carry their entity kind rather than assuming document

---

<a id="gm-8"></a>

## GM-8 · Process-flow direction is destroyed by the undirected dedup key: A→B and B→A collapse into one edge, so every recycle loop disappears from the Process lens

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/orgGraph.ts:34`, `lib/orgGraph.ts:46-50`, `lib/orgGraph.ts:173-181`, `lib/orgGraph.ts:282-289`, `components/graph/graphTheme.ts:44`, `lib/graphSettings.ts:40`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — two antiparallel flow rows collapse to one edge keeping only the first-seen direction — but the title's consequence and the report's own example are false. The cited distillation loop (tower→condenser, condenser→drum, drum→tower) is three DISTINCT unordered pairs and renders completely; only a true 2-node A⇄B recycle is lost. Compounding the low impact: DEFAULT_GRAPH_SETTINGS.showArrows is `false` (lib/graphSettings.ts:65), so direction is not drawn by default at all.

**Mechanism.** `GraphEdge` has no direction field — `{ a, b, type }` — yet `flow` is documented as directional ("process flow: from FEEDS to (directional in meaning)", orgGraph.ts:34; "Feeds (process flow)", graphTheme.ts:44) and there is a `showArrows` display setting (graphSettings.ts:40). Direction survives only as the insertion order of `a` and `b`. The dedup key, however, is order-insensitive:

```
const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
if (edgeSeen.has(key)) return;
```

So when process_flows holds both `T-101 FEEDS P-101` and `P-101 FEEDS T-101` (a reflux or recycle loop), the second row hits `edgeSeen` and is dropped. Whichever row the unordered `pageRows` pagination happened to return first determines the arrow's direction.

**Failure scenario.** A crude unit's overhead system is read off a PFD: tower feeds the condenser, condenser feeds the reflux drum, reflux drum feeds the tower. That third flow — the loop closure, the whole reason a distillation column is a column — is silently discarded as a duplicate of the first. With showArrows on, the Process lens draws a straight chain with a confident arrowhead and no loop, which is a wrong picture of the process, not merely an incomplete one.

**Evidence.**

```
lib/orgGraph.ts:46-50 `export interface GraphEdge { a: string; b: string; type: GraphEdgeType; }` — no direction. lib/orgGraph.ts:175 is the order-insensitive key. lib/orgGraph.ts:286-288: `for (const f of flows.rows) { if (f.status !== "confirmed") continue; addEdge(flowNodeId(f.from_kind, f.from_ref), flowNodeId(f.to_kind, f.to_ref), "flow"); }`
```

**Chain reaction.** Also note line 287 silently discards every non-confirmed flow with no count and no truncation, so a plant whose PFD reads produced 200 pending flows sees an empty Process lens and no explanation.

> **Verifier correction.** The rendered consequence is REFUTED and must not be carried forward. Flow edges are never drawn with arrows: components/graph/OrgGraph2D.tsx:202 gates arrowheads to `st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath)` under the comment "Direction, where direction means something" — `flow` is not in that list — and `grep -n 'arrow' components/graph/OrgGraph3D.tsx` returns nothing, so 3D draws no arrowheads at all. `showArrows` also defaults to false (graphSettings.ts:66). Therefore no wrong-direction arrow is ever shown, and a two-node recycle pair looks identical whether it collapses or not. The accurate finding is narrower: process-flow direction is not modelled and is not displayed anywhere on the graph, so the Process lens cannot answer "which way does it flow" — not that arrows point the wrong way or that loops visibly vanish.

**Done when.**

- [ ] The dedup key for directional edge types (flow, supersession) preserves order, or GraphEdge carries an explicit `directed` flag
- [ ] A test asserts that A→B and B→A both survive assembly as distinct flow edges
- [ ] Non-confirmed flows are either drawn as ghosts or their count is reported in truncations

---

<a id="gm-9"></a>

## GM-9 · REGION_ANCHOR_ORDER omits "plot", so indexOf returns -1 and any plot-plan node always hijacks its region's name

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/graphInsights.ts:47`, `lib/graphInsights.ts:166-177`, `lib/orgGraph.ts:23`, `lib/orgGraph.ts:216-221`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Confirmed exactly as claimed: any plot-plan node in a component wins the anchor race outright, so the region is named after the plot plan rather than its unit. Real but purely a display-label defect on the zoomed-out map (and the Process lens hides `plot` entirely, page.tsx:430), so LOW rather than MEDIUM.

**Mechanism.** `GraphNodeType` has seven members including `"plot"` (orgGraph.ts:23), and plot-plan nodes are created at orgGraph.ts:216-221. The region-naming preference list has only six:

```
const REGION_ANCHOR_ORDER: GraphNodeType[] = ["unit", "library", "project", "asset", "plant", "document"];
```

The anchor loop ranks by `indexOf`:

```
let anchorRank = REGION_ANCHOR_ORDER.length;   // 6
for (const id of members) {
  const rank = REGION_ANCHOR_ORDER.indexOf(n.type);   // -1 for "plot"
  if (rank < anchorRank || (rank === anchorRank && d > anchorDegree)) {
    anchor = n; anchorRank = rank; anchorDegree = d;
  }
}
```

`indexOf` returns -1 for `"plot"`. -1 < 6 so the plot node takes the anchor; afterwards no unit (rank 0), library (1) or asset (3) can displace it, because 0 < -1 is false. The plot node wins unconditionally and permanently, regardless of degree.

**Failure scenario.** A site uploads one plot plan and pins twenty assets on it (orgGraph.ts:275-280 writes a `plot` edge per marker). Those assets are also on Unit 20, so plot + unit + assets form one connected component. The zoomed-out map, whose whole purpose per the module header is to "read like a neighborhood map (\"Crude Unit\" over here)", instead labels that entire neighbourhood "Site Plot Plan Rev C" — and does so for every region a plot plan touches, which for a site-wide plot plan is most of the map.

**Evidence.**

```
lib/graphInsights.ts:47 quoted in full above — six entries, no "plot". lib/graphInsights.ts:171-175 is the ranking loop. lib/orgGraph.ts:23: `export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot";`. The unit test at lib/__tests__/graphInsights.test.ts:100-117 covers regions but a grep for "plot" in that file returns nothing — the case is untested.
```

> **Verifier correction.** MEDIUM is the right ceiling but the blast radius is narrow: the only consequence is the region's display label (graphInsights.ts:177 `regions.push({ label: anchor.label, ids: members })`). Membership, orphans, hubs and bridges are unaffected, and it only fires for orgs that have plot plans with asset markers.

**Done when.**

- [ ] REGION_ANCHOR_ORDER contains every GraphNodeType, or the loop treats indexOf === -1 as lowest priority (e.g. `const rank = idx === -1 ? REGION_ANCHOR_ORDER.length : idx`)
- [ ] The list is typed so that adding a GraphNodeType without adding it here is a compile error (Record<GraphNodeType, number>)
- [ ] A test builds a component containing a plot node plus a unit node and asserts the region is named after the unit

---

<a id="gm-10"></a>

## GM-10 · The graph does not model an entire level of the plant hierarchy (systems) and never reads documents.plant_id or documents.system_id, despite both being persisted FK columns

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:23`, `lib/orgGraph.ts:109-113`, `lib/operationalGraph.ts:172-208`, `supabase/migrations/20260606_operational_entity_graph.sql:113`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — systems are a whole hierarchy level the graph never models, and documents.plant_id/system_id are read nowhere in it. But a repo-wide grep for `system_id`/`systemId` shows NO primary write path: the only writers are lib/documentLifecycle/common.ts:182 (from an `input.systemId` no UI supplies), split.ts:115 and merge.ts:124 which merely copy an existing value. No component or API route sets it, so the described scenario is essentially unreachable through the product. Downgrade to LOW (a modelling gap, not a live defect).

**Mechanism.** `documents` carries three scope FKs — the migration adds `plant_id UUID REFERENCES plants(id)`, `unit_id UUID REFERENCES units(id)` and `system_id UUID REFERENCES systems(id)`. buildOrgGraph selects only one of them:

```
supabase.from("documents")
  .select("id, document_number, title, library_id, unit_id, sheet_number, sheet_total")
```

`plant_id` and `system_id` are not in the select list and no code in the file references them. `systems` is not a member of `GraphNodeType` at all, even though lib/operationalGraph.ts:172-208 provides full CRUD for it, `getScopeTree` assembles Plant→Unit→System, and the admin scope UI creates them (app/(protected)/admin/scope/page.tsx:260).

**Failure scenario.** A plant models its scope properly — Refinery → Crude Unit → Atmospheric Tower system — and files the tower's drawings against `system_id`. On /graph those drawings show no scope tie whatsoever: they float with only a library edge, which `contextEdges` (graphInsights.ts:39) explicitly discards, so they are all reported as ORPHANS. The more carefully an org uses the scope hierarchy, the more broken its graph looks. Likewise a corporate standard filed at `plant_id` level draws no edge to its plant node.

**Evidence.**

```
orgGraph.ts:110 select list quoted above contains `unit_id` and nothing else scope-related. `grep -rn 'ALTER TABLE documents ADD COLUMN' supabase/migrations/*.sql` returns `plant_id UUID REFERENCES plants(id) ON DELETE SET NULL`, `system_id UUID REFERENCES systems(id) ON DELETE SET NULL` and `unit_id UUID REFERENCES units(id) ON DELETE SET NULL`. orgGraph.ts:23 enumerates seven node types; "system" is not among them.
```

**Chain reaction.** Combined with finding 1 this means the graph models roughly one and a half of the four scope levels the database supports, which is the concrete answer to "is the graph comprehensive enough" — and it is why the two lenses are labelled oddly: "Process" is really "codebook units + assets" and "Equipment" is really "assets + documents", because neither can reach a full plant hierarchy.

> **Verifier correction.** HIGH is overstated — this is a modelling gap in a visualization, and one leg is already partially covered: documents.plant_id being unread is largely harmless because a unit-scoped document reaches its plant transitively through the doc→unit (:259) and unit→plant (:253) edges. Only documents scoped at plant level ONLY, and everything scoped at system level, are invisible to the graph. Note also this compounds with finding 1: the unit hop it relies on is the `unit:<uuid>` family, which no equipment ever joins.

**Done when.**

- [ ] documents.plant_id and documents.system_id are selected and drawn as "unit"-class edges to their plant/system nodes
- [ ] A `system` node type exists (or systems are deliberately folded into units with the decision documented in the module header)
- [ ] The lens presets are renamed to what they actually show, or rebuilt on scope rather than node-type subtraction

---

<a id="gm-11"></a>

## GM-11 · The same node shows two contradictory connection counts on one screen: NodePeek prints the full-graph degree, the Hubs list prints the filtered context degree

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:173-181`, `components/graph/NodePeek.tsx:89`, `lib/graphInsights.ts:39`, `lib/graphInsights.ts:60-65`, `app/(protected)/graph/page.tsx:645`, `app/(protected)/graph/page.tsx:408-418`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Confirmed: the peek header's number comes from the unfiltered full graph, while both the row list beneath it and the Hubs number come from the filtered context web, so the same node can show 3 in the header and 2 rows / 2 in Hubs on one screen. Genuine but cosmetic — no data is lost or wrong, only inconsistently labelled — so LOW.

**Mechanism.** Two independent degree computations exist. `GraphNode.degree` is incremented inside `addEdge` over the WHOLE assembled graph, including library edges and edges to nodes the current lens hides:

```
edges.push({ a, b, type });
nodes.get(a)!.degree += 1;
nodes.get(b)!.degree += 1;
```

`computeInsights` builds its own map over `contextEdges(edges).filter(...)` — library edges excluded, and only edges present in the filtered view (graphInsights.ts:39, 57-65). NodePeek renders the first (`{node.degree} connection{...}`, NodePeek.tsx:89); the Hubs panel renders the second (`{h.degree}`, page.tsx:645). Node radius in both renderers also uses the first (`Math.sqrt(n.degree)`, OrgGraph2D.tsx:242, OrgGraph3D.tsx:561), while the peek's own "connections" list (page.tsx:408-418) is built from the filtered view.

**Failure scenario.** A document filed in a library, tagged to one asset, superseding one predecessor: `degree` is 3. Under default settings (`showLibraryEdges: false`) the library edge is hidden. The user clicks it: the peek header says "Document · 3 connections", the list underneath it shows 2 rows, and if it appears in Hubs the amber number reads 2. Three numbers for one node. On the Process lens a heavily-tagged asset renders as a large circle (mass and radius from the unfiltered degree) while the Hubs panel scores it 1.

**Evidence.**

```
lib/orgGraph.ts:179-180 increments GraphNode.degree unconditionally inside addEdge. components/graph/NodePeek.tsx:89: `{labelFor(node.type)} · {node.degree} connection{node.degree === 1 ? "" : "s"}`. app/(protected)/graph/page.tsx:645: `<span className="...">{h.degree}</span>` where h comes from insights.hubs. lib/graphInsights.ts:39: `const contextEdges = (edges) => edges.filter((e) => e.type !== "library");`
```

**Done when.**

- [ ] One degree is authoritative for display; the peek, the hubs list and the connections list agree
- [ ] If both a total and a contextual degree are worth showing, they are labelled distinctly ("3 links · 2 in this view")
- [ ] Node radius/mass and the displayed count derive from the same number

---

<a id="gm-12"></a>

## GM-12 · The whole graph is rebuilt in the browser on every mount — up to ~47 HTTP round trips and ~48,000 rows, with five sequential eight-deep pagination chains

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/orgGraph.ts:96-144`, `lib/orgGraph.ts:74-94`, `app/(protected)/graph/page.tsx:102-132`, `app/(protected)/graph/page.tsx:106-109`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The rebuild-on-every-mount and the row volume are real (the finding in fact understates both: six chains, not five, and ~56k rows, not 48k). Two corrections lower it: the six chains run CONCURRENTLY inside one Promise.all, not sequentially, and a stale-while-revalidate sessionStorage snapshot (page.tsx:110-122) means a returning user sees the previous map immediately rather than 'no visible progress beyond a spinner' — the spinner only appears on a first visit or an oversized (>2MB) graph. A perf/cost concern, not a correctness one: LOW.

**Mechanism.** `Promise.all` fans out fifteen entries, but five of them are `pageRows` calls that each loop `for (let from = 0; from < cap; from += EDGE_PAGE)` — eight sequential awaits apiece at EDGE_CAP/EDGE_PAGE = 8000/1000. Worst case that is 8 serial round trips deep and 40 requests wide from `pageRows` alone, plus ten more from the direct queries, all from the client. Row volume at cap: 1500 documents + 2000 assets + 5×8000 join rows + 5000 mirror rows ≈ 48,500 rows parsed in the browser. The page comment describes this as "a dozen parallel table pulls" (page.tsx:106) which understates it by roughly 4x. The mitigation is a sessionStorage snapshot that big orgs never get:

```
const s = JSON.stringify(g);
if (s.length < 2_000_000) window.sessionStorage.setItem(snapKey, s);
```

A 3,500-node / 40,000-edge graph JSON-stringifies well past 2 MB, so exactly the orgs that most need the cache are silently excluded from it, with the failure swallowed by the bare `catch`.

**Failure scenario.** A user navigates away from /graph and back. The full 47-request rebuild runs again with no in-memory memo (the effect keys on activeOrgId only), no cached snapshot if the org is large, and no visible progress beyond a spinner — while the same user's earlier layout is already in localStorage. On a field tablet over plant wifi this is minutes of spinner.

**Evidence.**

```
lib/orgGraph.ts:79-92 is the sequential paging loop; lib/orgGraph.ts:99-144 shows five pageRows calls (document_assets, project_documents, document_related_resources, document_supersessions, entity_mentions) plus process_flows — six paged tables in total. app/(protected)/graph/page.tsx:120-122 quoted above for the 2 MB gate. page.tsx:102 the effect deps are `[activeOrgId]`.
```

**Chain reaction.** This is the same architectural fact as the service-role finding: assembly belongs on the server, where it can be one query plan instead of 47 round trips, can page all tables to completion, and can read the tables the client is REVOKEd from.

> **Verifier correction.** Two corrections. (1) The worst case is understated in one direction and badly overstated in another: it is 6×8 = 48 paged requests plus ~8 direct queries ≈ 56, not 47 — but pageRows early-exits at :91 (`if (batch.length < EDGE_PAGE) return`), so a join table holding fewer than 1000 rows costs exactly ONE request. The eight-deep chains only occur for orgs at or near EDGE_CAP=8000 in that specific table; a typical org makes roughly 14 requests, which is what the "dozen parallel table pulls" comment describes accurately. (2) No one ran the app or measured a payload, so the claim that a 3,500-node graph stringifies past 2 MB and the perceived slowness are estimates, not observations. Keep this as an architectural note (client-side assembly, no server cache, no incremental load), not as a measured performance defect.

**Done when.**

- [ ] Assembly moves behind an API route that assembles server-side and returns one payload
- [ ] The truncation/cache path reports when the snapshot was skipped rather than swallowing it
- [ ] The "dozen parallel table pulls" comment matches the real request count

---

<a id="gm-13"></a>

## GM-13 · Three of the five paged join tables never report their truncation, and the kdoc mirror cap turns dropped mentions into a false explanation — contradicting the module's own stated contract

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:17-18`, `lib/orgGraph.ts:164-167`, `lib/orgGraph.ts:306-315`, `lib/orgGraph.ts:107-108`, `lib/orgGraph.ts:137`, `lib/orgGraph.ts:141-143`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed and the module's own header contract at lines 17-18 is the line that settles it. The kdoc-mirror cap is the sharper defect: a mention on a mirrored PDF beyond the 5000th mirror is misreported to the user as evidence that the PDF was never brought under document control — a false explanation, not merely a missing one. Libraries and projects are also silently capped at 300 (orgGraph.ts:107-108), and plot plans at 300 (:137). MEDIUM stands.

**Mechanism.** The header states an absolute: "Every list is capped and the truncation is reported, never silent." A grep of `truncations\.push|\.capped` over the file returns six lines. `docAssets.capped`, `projectDocs.capped` and `mentions.capped` are reported. `related.capped`, `supersessions.capped` and `flows.capped` are never read. Four more hard limits report nothing at all: libraries `.limit(300)` (line 107), projects `.limit(300)` (line 108), plot_plans `.limit(300)` (line 137), knowledge_documents mirrors `.limit(5000)` (lines 141-143). The mirror cap is the damaging one, because unmapped mentions are then explained wrongly:

```
const docId = m.document_id
  ?? (m.knowledge_document_id ? mirrorOf.get(m.knowledge_document_id) : undefined);
if (!docId) { unmappedMentions += 1; continue; }
...
truncations.push(
  `${unmappedMentions} mention${...} come from library-only ` +
  "documents with no controlled counterpart — see the equipment page for those.",
);
```

If the org has more than 5000 mirrored knowledge documents, `mirrorOf` is missing entries for real, mirrored, controlled documents — and every mention through them is counted and announced as "library-only … with no controlled counterpart", which is the opposite of true.

**Failure scenario.** A site with 6,000 indexed PDFs mirrored from document control opens the graph. Roughly a sixth of all mention edges silently disappear from the map, and the amber notice states they come from library-only documents. A document controller reads that as "those PDFs were never brought under control" and opens a remediation task for files that are already controlled. Meanwhile a plant whose curated pins or supersession lineage exceeds 8000 rows loses revision-lineage edges with no notice at all — in a controlled-document system, silently dropping supersession edges is the worst possible edge to drop silently.

**Evidence.**

```
lib/orgGraph.ts:17-18 is the contract. The six push/capped sites are lines 164, 165, 166, 167, 306, 311 — `related`, `supersessions` and `flows` appear only at their pageRows call sites (122-134) and their `.rows` consumption (264-289), never their `.capped` flag. Lines 141-143: `.select("id, source_document_id").eq("org_id", orgId).not("source_document_id", "is", null).limit(5000)`.
```

> **Verifier correction.** HIGH is overstated and this substantially overlaps finding 2 — both are the same silent-cap class and should be merged when acting. The false-attribution consequence additionally requires an org with more than 5000 mirrored knowledge documents; below that threshold only the missing truncation notices apply.

**Done when.**

- [ ] Every pageRows result's `capped` flag pushes a truncation, and every `.limit(...)` in the file reports when it is reached
- [ ] The kdoc mirror map is paged to completion (or its cap is reported), so the unmappedMentions message can only ever be true
- [ ] A test asserts that a capped supersessions/related/flows pull produces a truncation string

---

<a id="gm-14"></a>

## GM-14 · knowledge_page_entities — the per-sheet equipment index with x/y positions — is REVOKEd from `authenticated`, and the graph is assembled entirely client-side, so the data the owner's per-sheet question needs is structurally unreachable from the graph

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260921_drawing_entities.sql:15-38`, `lib/orgGraph.ts:20`, `lib/orgGraph.ts:96-144`, `app/(protected)/graph/page.tsx:115`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Every factual assertion checks out — the REVOKE is real, the graph is 100% client-assembled, and a sheet edge type added to buildOrgGraph would silently return nothing. But this is a deliberate, documented ACL decision (the table mirrors per-document ACLs the anon client cannot evaluate), and no shipped feature is broken by it — the finding describes a hypothetical future feature. That is a design constraint to note, not a MEDIUM defect: LOW.

**Mechanism.** buildOrgGraph imports the browser client (`import { supabase } from "@/lib/supabase"`) and is invoked directly from the client component (`buildOrgGraph(activeOrgId).then(...)`, page.tsx:115). It therefore runs with the caller's JWT under the `authenticated` role. The table that records which equipment tag appears on which sheet, and where on the sheet, is service-role only:

```
-- Service-role only: entities mirror ACL-protected documents; the drawing
-- API filters per caller through the real ACL engine, same as ask.
CREATE TABLE IF NOT EXISTS knowledge_page_entities (
  ... document_id UUID ..., page INTEGER NOT NULL, kind TEXT ..., tag TEXT ...,
  x REAL, y REAL
);
ALTER TABLE knowledge_page_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge_page_entities FROM public, anon, authenticated;
```

No amount of edge-type work in orgGraph.ts can surface it: the client cannot SELECT the table at all. The same applies to knowledge_line_traces (20261007_line_traces.sql:14 states it is "Service-role only, same as knowledge_page_entities").

**Failure scenario.** The owner asks for "which equipment is on which sheet" on the map. The rows already exist — tag, page, x, y, per document — and the graph can never draw them, because the only consumer able to read them is a server route. Any attempt to add a `sheet` edge type to buildOrgGraph returns an empty result set with no error (PostgREST reports a permission failure that `optional()` at orgGraph.ts:152 would swallow to `[]`), so the feature would appear to work and produce nothing.

**Evidence.**

```
20260921_drawing_entities.sql:38 `REVOKE ALL ON knowledge_page_entities FROM public, anon, authenticated;` with the header comment at lines 15-16 explaining why. lib/orgGraph.ts:20 imports the browser client, not supabaseAdmin. page.tsx:115 calls buildOrgGraph in a "use client" component. Contrast app/api/graph/mentions/route.ts:13 and app/api/graph/shape/route.ts:22, which correctly use supabaseAdmin behind a role check.
```

**Chain reaction.** This is an architectural ceiling, not a bug: as long as assembly is client-side, the graph can only ever model tables readable by `authenticated`. Every richer edge the owner wants (sheet membership, drawing-extracted tags, line traces, Bridge suggestions) lives behind service-role tables. Moving buildOrgGraph behind a `/api/graph/build` route (ACL-filtering documents server-side exactly as documents_acl_select does) is the prerequisite for questions 5, 6 and 7.

> **Verifier correction.** Reframe and downgrade. The REVOKE is not a defect — it is a deliberate, documented, correct ACL decision, and "structurally unreachable" is too strong: the finding's own evidence shows the established pattern for reaching such data (a server route on supabaseAdmin behind a role check, exactly what api/graph/mentions and api/graph/shape already do). The accurate statement is an architectural constraint: because the graph is assembled client-side, per-sheet equipment placement cannot be added to it by editing orgGraph.ts alone; it needs a server route first. Nothing leaks and nothing is broken today.

**Done when.**

- [ ] Graph assembly runs server-side under supabaseAdmin with explicit per-caller ACL filtering equivalent to node_visible(), or a dedicated route supplies the service-role-only edges
- [ ] A `sheet` edge (document ↔ asset, carrying page number) is drawn from knowledge_page_entities
- [ ] The client-side buildOrgGraph either is removed or documents in its header that it can only ever see `authenticated`-readable tables

---
