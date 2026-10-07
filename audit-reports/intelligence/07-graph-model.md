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
- **Status:** RESOLVED
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

**Resolution (2026-10-02, intelligence Round G).** Reproduced first (DEC-29): on the base `d6335b1`, `app/(protected)/graph/page.tsx:239-242` fed `computeInsights(view.nodes, view.edges)` — the lens-filtered slice. `lib/__tests__/graphView.test.ts` "GM-1 …" shows that computation orphaning P-102 (tied only to its unit and a plot plan) under the Equipment ↔ Documents lens, and `lib/__tests__/graphPageRender.test.ts` "the orphan badge does not move …" fails against the base page. What landed, in `app/(protected)/graph/page.tsx`:
- `insights` is `computeInsights(graph.nodes, graph.edges, { access: graph.access })` over the whole assembled map (`:375`). Only the map's region names follow the view (`:380`), because they label what is drawn.
- The panel filters the RESULT for display: an orphan or hub the current view hides is listed faded, and the orphan copy says how many ("N of these are hidden by the current view (faded)"). Clicking a faded row shows the item before selecting it, by the same path as the "hidden by this view — Show it" note (`reveal`, `:695`, through `showTypesOf`, `:685`: unhide its type — library links with a library — leave focus, and select it once the map draws it), so a row never selects a node the map does not draw (fix pass). *(Corrected at fix pass 3: bridges were left out of this. A bridge whose end the lens hid was listed neither faded nor revealed, and its click spotlighted node ids the map did not draw. Bridges are now displayed through the view like orphans and hubs — the I-14 fix pass 3 note below.)*
- The copy states the real predicate: "No equipment, unit, project or link anywhere on the map — not just in this view — so no context yet." Above the lists: "Counted on the whole map, whatever this view shows." The red badge is the whole map's count, so it no longer moves with the lens.

**Done-when.**
1. ✓ `computeInsights` runs on the full assembled graph and the panel filters the result for display (faded rows, the hidden count; a faded row is shown before it is selected — `graphPageRender.test.ts` "an orphan the lens hides is shown, then selected …", "a hub the lens hides is shown, then selected"). *(Corrected at fix pass 3: first ticked with bridges unfiltered; orphans, hubs and bridges are all filtered for display now.)*
2. ✓ The orphan copy states the real predicate. Computed on the whole map, the predicate no longer depends on `hiddenTypes`, and the panel says so.
3. ✓ `graphView.test.ts` "hiding the unit and plot types does not orphan equipment whose only tie is a hidden-type edge"; `graphPageRender.test.ts` "the orphan badge does not move when a lens hides the types an item is tied by".

**Scope / residual.** Hubs and bridges are the whole map's too. A scoped map is a different assembled graph (I-13's scoped assembly), so its insights are the scope's, and the basis note says so (`GM-6`).

**I-14 fix pass 3 (2026-10-02).** Reproduced first (DEC-29): at `035207c` the Bridges tab drew every row alike and its click ran `spotlight([b.a.id, b.b.id])` whatever the view drew. Under the Plant lens a document ↔ equipment bridge was listed at full strength, and a click lit up a document the map did not draw. What changed, in `app/(protected)/graph/page.tsx`:
- A bridge is drawn only when both its ends are. Otherwise its row is faded, with "Hidden by the current lens or filter — click to show it". The copy counts them: "N of these are hidden by the current view (faded) — a click shows it." (`bridgesHidden`, `:790`; the rows at `:1121-1141`). *(Corrected at fix pass 4: the rows were cited as `:1107-1127`; at fix pass 3 they ran from `:1108` to `:1128`. Both references here are remapped to the fix-pass-4 page.)*
- A click on a hidden bridge shows both ends' types through the same path as `reveal`. That leaves focus and "hide unlinked", and turns library links on with a library (`showTypesOf`, `:685`). It then lights the pair up (`revealBridge`, `:703`), so the spotlight names only drawn nodes. An in-view bridge's click is unchanged. *(Corrected at fix pass 4: in 2D, "lights the pair up" did not frame the pair. The spotlight was set in the same commit as the filter change, so the camera flew to the end already drawn, or nowhere when both ends were hidden. The spotlight now waits one commit — the I-14 fix pass 4 note below.)*

Tests: `graphPageRender.test.ts` "GM-1 — a bridge the view hides (fix pass 3)" — "drawn: the row is not faded and a click lights the pair up (as before)", "hidden by the lens: faded and said; a click shows both ends, then lights the pair up on the map", "hidden by focus: a click leaves focus so both ends are drawn". All three fail against `035207c`'s page. *(Corrected at fix pass 4: this said "the last two fail". The first fails too, but only because `data-testid="bridge-row"` is new at fix pass 3: at `035207c` it finds no row.)* Line references in this block were remapped to the fix-pass-3 page, and again to the fix-pass-4 page.

**I-14 fix pass 4 (2026-10-07).** The re-review of fix pass 3 found that in 2D a hidden-bridge click did not frame the pair. Reproduced (DEC-29) with the fix-pass-3 `revealBridge` on the real `OrgGraph2D` (the re-review's scratch, and this pass's test run against that code), with the two ends saved at x = −600 and x = +600: after the reveal the camera ended at the drawn end (the frame's translate settled at 599.5), not at the midpoint. The cause is effect order. `revealBridge` set the spotlight in the same commit as the filter change. `OrgGraph2D`'s fly effect (`components/graph/OrgGraph2D.tsx:96-112`) belongs to a child, so it runs before the page's effects, and the page feeds the new view to the simulation in its own effect (`app/(protected)/graph/page.tsx:312-331`). When the fly ran, the revealed end was not in the simulation yet, so the fly framed only the end already there, or did not move when both ends had been hidden. What changed, in `app/(protected)/graph/page.tsx`:
- `revealBridge` (`:703`) shows both ends' types and clears the selection as before. It then sets `pendingSpotlight` (`:702`) instead of the highlight.
- An effect declared after the simulation-feed effect (`:715-719`) applies it with `spotlight`, the in-view bridge's own path. By then the simulation holds both ends, so the fly the new spotlight starts frames the pair. This is how a URL's node already waits in `pendingSelect` (`:360-372`). It also covers review nit (d): the reveal now goes through `spotlight` with the selection cleared. The highlight it sets is the one the earlier code set.
- 3D was not affected. `OrgGraph3D` reads the fly target in its frame loop, after effects have run. The page-level fix applies to both renderers.

Tests: `graphPageRender.test.ts` "on the REAL 2D renderer, the reveal frames both ends (fix pass 4)". The page's renderer stand-in can render the real `OrgGraph2D` (`g.real2D`), with a stub canvas and hand-run animation frames:
- "one end hidden by the lens: the camera ends at the pair's midpoint, not at the drawn end";
- "both ends hidden by focus: the camera still flies, to the pair's midpoint".

Negative control: with `revealBridge` setting the highlight in the same commit again, both fail. In the first the camera ends at x = −599.53, the drawn end. In the second it stays at (0, 0), where it started. Both pass with the fix. The three fix-pass-3 bridge cases pass on both versions.

Left as is (review nit (c)): a reveal's filter change has no one-click undo. "Show it" and the faded Insights rows work the same way (`reveal`), and the lens bar's undo covers only a lens tap (GPV-10). Changing that is a different behaviour for all three, not part of this finding.

---

<a id="gm-2"></a>

## GM-2 · Documents and equipment attach to two DIFFERENT unit node families that no edge ever joins — assets.unit_id is dead code, never written by any path

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here "a mapped operational unit IS its codebook unit" fails with `expected […] to not include 'unit:u1'`: the drawing (documents.unit_id → `unit:u1`) and the exchanger (assets.unit_code → `cbunit:20`) had no path between them. Decision, the plan's default (`DEC-67`, provisional number): keep BOTH unit models — a configured operating unit and a decoded code mean different things — JOIN them as data, retire nothing. What landed:
- `supabase/migrations/20261138_intel_roundG_unit_identity.sql`: `units.codebook_code` with a UNIQUE `(org_id, codebook_code)` partial index — the persisted mapping row, one codebook unit to at most one operational unit; `documents.unit_code` for the drawing-number decode (kept the decode's by `trg_documents_unit_code_guard`). Review fix (2026-10-01): `trg_units_codebook_code_guard` makes the mapping the Operational scope writer tier's in the database — the only policy on `units` (`units_member_all`, 20260606) lets any active member write the row, so the page's `canEdit` was a browser check alone; every change to the mapping (a code set, cleared, released by an archive, or deleted with its row) by anyone else is now refused 42501, and an archived unit holds no code (archiving releases it, so the code can be remapped).
- `lib/orgGraph.ts` (`assembleOrgGraph`): an operational unit mapped to a codebook unit IS that unit's node (`cbunit:<code>`) — its unit_id edges, its plant edge and its systems land there, and the node carries `unitId` / `plantId`; an unmapped units row stays its own `unit:<uuid>` node (a configured unit the codebook does not hold). `documents.unit_code` draws document → `cbunit:<code>`. Where the decode and documents.unit_id disagree, both ties are drawn and a truncation counts them. Third review fix (2026-10-01): they "differ" only when the operational unit is mapped to a codebook unit other than the decode (or, for equipment, the filing); an operational unit that is not mapped — or not on the map — was counted as a disagreement, so right after 20261138 (before anyone maps units) every decoded document with a `documents.unit_id` read as mis-filed. It is now counted apart with its own note ("… carry an operational unit that is not mapped to the Site Codebook … cannot be compared"), as the decode's report (`unitIdUnmapped`) and 20261138's inventory keep it.
- `assets.unit_id` is now written: `lib/operationalGraph.ts` `planUnitIdentity` FILLS an empty `assets.unit_id` with the operational unit mapped to `assets.unit_code`, run by `POST /api/admin/unit-identity` (the unit-identity backfill: service role, preview by default, refusals counted, audited) from the new Unit identity panel on `/admin/scope`, where each operational unit is mapped (`setUnitCodebookCode`, a checked write that reads the value back). Review fix (2026-10-01): the first cut also re-pointed or cleared a value already there whenever it pointed at a mapped unit, treating it as its own stale output — on a first run every such value was set by hand or by an import, and the audit kept counts only, so nothing recorded what was overwritten. A value already there is now never rewritten: one that disagrees with the filing is counted (`disagreeWithFiling`), one held while the filing maps to no unit is kept (`keptWithoutFiling`), the way a document's disagreement is counted and both ties drawn. Second review fix (2026-10-01): the rule now holds in the UPDATE itself — a fill lands only while `unit_id` is still NULL and the item still has the planned filing (`.is("unit_id", null).eq("unit_code", …)`), so a unit set by hand between the decode's read and its write is kept and counted `changed` instead of overwritten (GAP-305 (d)). Third review fix (2026-10-01): the backfill was the projection's only writer and nothing kept it current — a refile (`lib/assets.ts` `updateAsset`, or the Bridge filling `unit_code`) or a remap of the unit left the old unit on the equipment permanently (every later run reported it "kept"; no screen sets or clears `unit_id`), and equipment created after a run had none until someone re-ran the decode. 20261138 now keeps the projection in the database for every writer: `trg_assets_unit_id_follows_filing` (BEFORE INSERT OR UPDATE OF unit_code ON assets; not SECURITY DEFINER) gives a new item the unit its filing maps to, moves a refiled item's unit when it was the old filing's projection (or empty), keeps a unit that disagreed with the old filing (set by hand or by an import), and takes a write that sets `unit_id` itself as written; `trg_units_codebook_code_follow` (AFTER INSERT OR UPDATE OF codebook_code, archived ON units; SECURITY DEFINER as a foreign key's own cascade is, re-checking the scope writer tier) moves a released code's projected equipment to the code's holder (none) and fills the new code's empty equipment. The decode's own fill goes through the same trigger — it re-sends the planned filing on a row whose unit is still empty, and the database fills it by the mapping as it stands at the write — so a remap between the decode's read and its write lands the new holder (or none), never the planned unit, and is counted `changed` (GAP-305 (g)). Fourth review fix (2026-10-01): because a mapping change now moves equipment, `/admin/scope` no longer tells a person archiving a mapped unit that "equipment that references it keeps its data": a mapped unit's archive, unmap or remap is confirmed with what it does — the codebook unit, how many items filed under the code point at the unit and lose it (`countProjectedEquipment`), and that restoring an archived unit does not restore the mapping (`codebookReleaseConfirm`; GAP-305 (j)).

Tests: `lib/__tests__/orgGraph.test.ts` (new; 30 cases after the review fixes — the third adds an unmapped operational unit that is "cannot be compared", never "differ", over the filter-aware stand-in `lib/__tests__/helpers/graphFakeDb.ts`) — one node per unit, the 2-hop case, the decode-only case, the unmapped unit, the disagreement note, the pre-migration fallback; `lib/__tests__/intelRoundGUnitIdentity.test.ts` (the fill-only projection rules — a hand-set or imported value on a mapped unit is kept through a real apply; the route; the mapping write and its read-back; the migration's shape, including the mapping guard's role list pinned to `ADMIN_SURFACES` "scope".writes; third review fix: a refile after a decode moves the projected unit and `searchAssets({ unitId })` follows it, a remap after a decode moves the projected equipment to the code's new holder, equipment created after a decode carries its unit at once, a remap between the decode's read and its write is never written as it was, and the two projection triggers' shape and probes). The migration was applied to a scratch PostgreSQL 16 with stubbed auth (every probe true; see GAP-305).

**Pending migration:** `supabase/migrations/20261138_intel_roundG_unit_identity.sql` (hand-applied; one paste — its result set carries the pre-apply inventory and every probe). Until it is applied the graph builds on the legacy columns and says so ("The unit-identity migration (20261138) is not applied …"), and the decode route answers 409.

**Done-when.**
1. ✓ A persisted mapping row joins them: `units.codebook_code`, unique per org (20261138); `documents.unit_code` carries each document's decode.
2. ✓ buildOrgGraph emits one node per real unit: a mapped operational unit is its codebook unit's node; no `unit:<uuid>` twin is drawn for it.
3. ✓ `orgGraph.test.ts`: a document with unit_id `u1` (mapped to 20) and an asset with unit_code 20 are exactly 2 hops apart; so are a document carrying only unit_code 20 and that asset.
4. ✓ `assets.unit_id` is written and kept current — the database projects it on every insert, refile and mapping change (20261138's two projection triggers: `lib/assets.ts` `createAsset` / `updateAsset` write `unit_code`, and the projection follows; the file is not edited), and the unit-identity backfill fills what the triggers could not see — so the `if (a.unit_id)` branch is live, and a projected value resolves through the mapping to the same node as the filing, after a refile or a remap too (corrected at the third review: before, only a manual decode run wrote it, and a refile or remap left it pointing at the old unit for good). A unit set by hand that disagrees with the filing is kept, drawn as a second tie and counted.

**Scope / residual.** The mapping is entered by a person on /admin/scope, never inferred (20261138's inventory counts operational units whose code equals a codebook code as a hint only). A document created or renumbered after a decode run has no unit_code until the next run (the database drops a renumbered document's old decode); a create-time decode belongs with the writers that already decode — the Bridge at ingest (I-11, `lib/equipmentBridgeServer.ts`) and document creation (document-control, `lib/documentLifecycle`) — which are not this package's files. Equipment needs no re-run: the database projects its unit on insert, refile and remap (20261138). A unit set by hand that disagrees with the filing is kept — `assets.unit_id` records no provenance, so one that happens to equal the old filing's projection is treated as the projection: it moves on a refile and is cleared when its unit's code is released by an unmap, a remap or an archive (no screen sets one by hand today; the release confirmation counts it). Apply 20261138, map the units, run the decode.

---

<a id="gm-3"></a>

## GM-3 · Node caps silently sever edges, and the truncation notice that fires ("densest web shown") is factually false — edge pagination has no ORDER BY at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here an org past ASSET_CAP produced no note about the severed links and still said "densest web shown". What landed in `lib/orgGraph.ts`:
- `pageRows` pages in KEYSET order (`.order("id")`, `.gt("id", last)`) — never an unordered OFFSET window — and, when the cap is reached, one head count says how many rows exist ("8,000 of 12,345 read"); `pageIn` does the same over `IN` chunks.
- documents (`updated_at` desc, `id`), assets (`tag`, `id`), libraries / projects / plot plans (`name`, `id`) are read with an explicit ORDER BY to `cap + 1` rows, so "the first N" is a rule and a cap is reported only when it is actually exceeded. Documents and equipment are read in WINDOWS of at most 1,000 rows (corrected at review — below).
- `addEdge` keeps its endpoint guard (Verified sound — an edge still never dangles) and now COUNTS what it drops, per edge type: one truncation names the total and the breakdown ("N links lead to equipment, documents or units not on this map (beyond a cap above, archived, or outside your access) — 5 equipment-tag, …") and `OrgGraph.severed` carries the number.
- "densest web shown" is gone; every cap note states its rule ("Showing the first 2,000 equipment items by tag.").

*Corrected at review (2026-10-01).* The first cut read documents with ONE `.limit(1501)` request and equipment with ONE `.limit(2001)` request, and the operational units, plants, systems and codebook units with one unpaged request each. PostgREST cuts every response at db-max-rows (1,000 by default) without an error (the repo's own `lib/assets.ts` AREA-9 note), so neither cap could ever be reached in production: an org with 1,200 documents and 2,005 equipment items got 1,000 of each, no cap note, and the severed-link note blamed "a cap above" that was never shown. The tests passed only because the stand-in honoured any limit. Now no request of the assembly asks for more than 1,000 rows: `readDocumentsByRecency` reads `.range()` windows over (`updated_at` desc nulls last, `id`) until DOC_CAP + 1 rows are in hand (rows kept once by id, so a document re-sorted between two windows is not drawn twice); `readAssetsByTag` reads KEYSET windows over (`tag`, `id`) — each window starts at the last tag read (`tag >= last`) and drops the rows already in hand, so a tag shared by rows on both sides of a window edge loses none; `readStructure` pages codebook units, operational units, plants and systems through `pageRows` (keyset, to `STRUCT_CAP` = 5,000 each, a cap said with its count) for both the org-wide and the scoped assembly. The stand-in now cuts every response at 1,000 rows (`maxRows`, as production), so a single over-sized request can no longer pass a test.

Tests: `lib/__tests__/orgGraph.test.ts` (new, 30 cases, over the filter-aware stand-in `lib/__tests__/helpers/graphFakeDb.ts`, which cuts every response at max-rows), the GM-3 / GPV-6 block: the reviewer's scenario (1,200 documents all drawn with no document note; 2,005 equipment items → the equipment note fires and the first 2,000 by tag are drawn); DOC_CAP + 300 documents → the 1,500 most recent are drawn across windows (undated last) and the note fires; a tag shared across a window edge loses no row; 1,005 systems are all drawn and STRUCT_CAP + 3 says "Systems capped — 5,000 of 5,003 read"; no request of a build asks for more than 1,000 rows. `lib/__tests__/scope.test.ts`: a unit with 1,005 systems draws every one on its own map. Against the first cut with the max-rows stand-in, 9 of these cases fail on this mechanism (e.g. `expected … to have a length of 1200 but got 1000`).

**Done-when.**
1. ✓ Edges are counted at the existence guard and a truncation reports the dropped count, by type.
2. ✓ Link-table paging is keyset-ordered on the unique `id`; the assets read is `.order("tag").order("id")` in keyset windows; the documents read is `.order("updated_at", desc nulls last).order("id")` in range windows.
3. ✓ The "densest web shown" strings are removed.
4. ✓ `orgGraph.test.ts`: ASSET_CAP + 5 assets with links to the five past the cap → "5 links lead to … — 5 equipment-tag." and `severed === 5`; exactly ASSET_CAP is not reported as a cap — and (corrected at review) both hold under a stand-in that cuts every response at 1,000 rows, as PostgREST does.

**Scope / residual.** The cap values are unchanged; the way past them for a unit is GAP-306's scoped assembly (`buildOrgGraph(orgId, { scope })`), which loads that unit's whole population. Recorded at the fourth review: the windowed and paged reads (`pageRows`, `pageIn`, the document and equipment windows) end at a window shorter than they asked for, so they assume PostgREST's max-rows is at least 1,000 — the default, and what the stand-in emulates; a project that sets it lower gets a short graph with no cap note. The unit-identity route, which writes from what it reads, pages to an empty window instead (GAP-305 (m)).

---

<a id="gm-4"></a>

## GM-4 · optional() swallows every query error — a failed assets, units, plants, projects, flows or plot-plan read renders a silently smaller graph with no error and no truncation

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here a statement timeout on the assets read rendered an equipment-free map with no note (`expected '' to match /Equipment could not be loaded/`). What landed in `lib/orgGraph.ts`: `optionalRows(res, what, notes)` — a pre-migration missing table (42P01 / PGRST205) contributes nothing silently, exactly as `pageRows` already did; ANY other error appends "<What> could not be loaded (<message>) — the map is incomplete." It covers equipment, operational units, plants, systems, projects, plot plans, knowledge libraries and the Site Codebook units — now read directly, because `loadCodebook` answers an empty book on any error (a failed codebook read used to delete every unit node silently). (Review fix, 2026-10-01: operational units, plants, systems and the codebook units are now read by `readStructure` — paged past PostgREST's max-rows, see GM-3 — with the same "could not be loaded" note.) The link tables keep `pageRows`' shape (a real error is fatal, now naming the table), and documents and libraries stay fatal.

Tests: `lib/__tests__/orgGraph.test.ts` (new, 24 cases, over the filter-aware stand-in `lib/__tests__/helpers/graphFakeDb.ts`), the GM-4 block (a timeout on assets; JWT-expired plot plans, failing units and codebook reads each noted; missing process_flows / entity_mentions tables silent; a real link-table error fatal).

**Done-when.**
1. ✓ The optional reads narrow to the missing-table codes and record a truncation for any other error.
2. ✓ Every swallowed error appends a visible note naming what could not be loaded and why.
3. ✓ `orgGraph.test.ts` injects a non-42P01 error on the assets query and asserts the note.

**Scope / residual.** None.

---

<a id="gm-5"></a>

## GM-5 · Bridge detection systematically misses the most common real bridge, because a doc↔asset pair carrying both a tag edge and a mention edge is treated as a redundant parallel connection

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): the new GM-5 cases in `lib/__tests__/graphInsights.test.ts`, run against the base commit's `lib/graphInsights.ts`, report 0 bridges for two clusters joined only by a drawing that is both tagged to E-2201 and names it. What landed in `lib/graphInsights.ts`: adjacency is one logical link per node PAIR, and a pair is never disqualified for carrying several edge types — the multiplicity map and its `=== 1` test are removed. The traversal (disc/low/subtree bookkeeping, the single-parent skip — this report's "already there" row) is untouched. In this graph a pair can carry two edges only as two TYPES (addEdge dedupes one edge per type per pair, and a directional type now one per direction), and two types between the same two things are one relationship: remove the pair and the clusters fall apart. 08's substrate row praising "a pair connected twice can never be a bridge" is superseded by this finding; the existing case that encoded it (a related + tag pair) is rewritten in place with the reason.

Tests: `lib/__tests__/graphInsights.test.ts` — the PID-4402 / E-2201 tag+mention bridge (sides 6 / 6), the rewritten two-type pair, a flow in each direction, and a source pin that no multiplicity test remains.

**Done-when.**
1. ✓ Multiplicity counts relationships — the pair — not edge types.
2. ✓ Two clusters joined only by a doc/asset pair carrying a tag and a mention report that bridge.
3. ✓ By construction: no analysis path suppresses a candidate bridge any more. The only filter left is the side-size floor (`minBridgeSide`), which the empty state's own words ("every big neighbourhood has redundant connections") already name, so "no bridges found" is now the only empty state there is; the source pin keeps it so. The panel copy itself is the page's (I-14).

**Scope / residual.** None.

---

<a id="gm-6"></a>

## GM-6 · Insights are ACL-dependent but presented as facts about the plant: the same map yields different orphan, hub and bridge answers for a controller and a viewer

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** intelligence I-14 GRAPH PAGE, LENSES & RENDERERS — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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

**Partial (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here a granted-nothing member's graph was silent about the restricted drawing it could not see. What landed:
- `supabase/migrations/20261138_intel_roundG_unit_identity.sql` `documents_total_for_org(p_org_id)`: the org's document COUNT for an active member, 0 for anyone else — never a row, an id or a title. SECURITY DEFINER (the count must be whole whatever the caller reads), `SET search_path = public`, EXECUTE revoked from PUBLIC and anon and granted to authenticated (DRLS-16's rule; a NULL `auth.uid()` matches no member and gets 0).
- `lib/orgGraph.ts` `readAccess` compares it with the reader's own count (a head count under documents RLS) → `OrgGraph.access { documentsVisible, documentsTotal, outsideAccess, documentsDrawn, scoped }` and, when the reader is missing documents, the truncation "N documents in this org are outside your access and not on this map — orphans, hubs and bridges are computed on what you can see." — shown by the page's existing truncation strip.
- A SCOPED graph makes no total or outside-access claim (`documentsTotal` and `outsideAccess` are null, `scoped: true`). Review fix (2026-10-01): the first cut reported the scope's resolved count as the total and the relation-named hidden documents as `outsideAccess` — but a scope is resolved from the reader's own reads, so a restricted document decoded, filed or pinned to the unit never enters it, and that count under-stated what the reader's ACL removed. The scope still states the floor it does know as a truncation ("N documents linked to <unit>'s equipment are outside your access — not drawn").
- `lib/graphInsights.ts`: `computeInsights(…, { access })` returns `basis { viewerScoped: true, outsideAccess, note }` (`insightsBasisNote`) — the label for the Insights counts. Review fix (2026-10-01): the note never says "every document in the org" — org-wide with nothing hidden it says "Computed on the documents on this map; none of the org's documents are hidden from you." (and, past the document cap, how many of the visible documents are drawn); on a scoped map it says the answers are computed on the scope's documents the reader can see, with documents outside their access not in it.

Tests: `lib/__tests__/orgGraph.test.ts` GM-6 block — a controller and a granted-nothing member assemble different graphs (V-7 is an orphan only for the member) and only the member's says so; with no count function (pre-migration) the graph makes no claim; an org-wide map past DOC_CAP says how many documents are drawn. `lib/__tests__/scope.test.ts` — a hidden governing drawing is stated as a floor; twelve private drawings DECODED to the unit are invisible to a granted-nothing member's resolution, and the scoped graph makes no count claim and its basis never says "all". `graphInsights.test.ts` — the basis for the scoped, capped and uncapped cases, and never "every document in the org". The review-fix cases fail against the first cut.

**Pending migration:** `supabase/migrations/20261138_intel_roundG_unit_identity.sql` (hand-applied; one paste — its result set carries the pre-apply inventory and every probe). Until it is applied the graph builds on the legacy columns and says so ("The unit-identity migration (20261138) is not applied …"), and the decode route answers 409.

**Done-when.**
1. ✓ The org-wide graph reports the count the reader's ACL removed (`access`, and the truncation line). A scoped graph cannot count it and says only the floor it knows (above).
2. **Not met here:** Insights counts are labelled viewer-scoped where a user sees them. The line on the map says what the orphans, hubs and bridges were computed on whenever the reader is missing documents, and `GraphInsights.basis.note` carries the label for the Insights panel — but nothing displays `basis.note` yet: placing it beside the counts is `app/(protected)/graph/page.tsx`, I-14's file (the page also does not pass `access` to `computeInsights` yet).
3. ✓ `orgGraph.test.ts` compares the two readers on one org and asserts the difference is surfaced.

**Scope / residual.** One read widens and is declared in the migration header: an active member learns how many documents the org holds (never which). Before 20261138 is applied the graph makes no access claim (`access` null). Remaining limb: I-14 passes `graph.access` to `computeInsights` and places `basis.note` in the Insights panel. Corrected 2026-10-01 at review: first recorded RESOLVED, with a scoped `outsideAccess` that under-counted and a basis note that could say "every document in the org".

**Resolution (2026-10-02, intelligence Round G).** The remaining limb. The page passes `graph.access` to `computeInsights` (`app/(protected)/graph/page.tsx:375`). It renders `GraphInsights.basis.note` under the Insights tabs (`data-testid="insights-basis"`, `:1057`), after "Counted on the whole map, whatever this view shows." Test: `lib/__tests__/graphPageRender.test.ts` "the orphan badge does not move …" asserts the note carries "3 more are outside your access" for a graph whose `access.outsideAccess` is 3; it fails against the base page, which displayed no basis.

**Done-when.**
1. ✓ (I-13) The org-wide graph reports the count the reader's ACL removed.
2. ✓ Insights counts are labelled viewer-scoped where a user sees them: `basis.note` sits beside the counts.
3. ✓ (I-13) `orgGraph.test.ts` compares the two readers.

**Scope / residual.** `documents_total_for_org` is `20261138`'s, still Pending in `audit-reports/MIGRATION-PASTE-ORDER.md`. Until it is pasted, `access` is null and the note says only "Computed on the documents you can see." — no count is claimed. A scoped map's note says it was computed on the scope's documents the reader can see.

---

<a id="gm-7"></a>

## GM-7 · Link proposals are drawn as document↔document unconditionally and swallow their own errors, so a failed or capped proposal read is indistinguishable from "no proposals"

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-02, intelligence Round G).** Reproduced first (DEC-29): base `lib/linkProposals.ts:252-261` `listPendingPairs` answered `[]` on any error and read one `.limit(4000)`, which PostgREST cuts at db-max-rows (1,000) with no error. `app/(protected)/graph/page.tsx:125-130` swallowed the rejection too. The chip counted `view.ghosts.length`. `lib/__tests__/graphPendingProposals.test.ts` pins the new reader; `graphPageRender.test.ts`'s GM-7 cases fail against the base page. What landed:
- `lib/linkProposals.ts` `readPendingProposalPairs(orgId)` → `{ pairs, total, capped, error }` (`:323`):
  - reads in windows of at most 1,000 rows, in a fixed order, so "the first 4,000" is a rule. *(Corrected at fix pass 3: first built as OFFSET windows (`range`) ordered by `confidence` desc then id. No index covers `confidence`, so every window sorted the whole pending queue under the RESTRICTIVE `proposed_links_read_endpoints` policy. The read is now KEYSET windows, newest first, on (`created_at` desc, `id` desc). `proposed_links_org_status_idx` (org_id, status, created_at DESC) orders the first of the two.)* *(Corrected at fix pass 4: this called (`created_at` desc, `id` desc) "the order of" the index. The index holds no `id`. The rows one Find-connections run inserts share one `created_at`, so inside one run the order is uuid order, and "the newest" inside a run means uuid order — the I-14 fix pass 4 note below.)*;
  - counts the reader's pending queue (proposed_links RLS shows only pairs whose documents the reader can read — LNK-4). *(Corrected at fix pass 3: first an exact count on the first window. Now the read itself is the count below the cap. At the cap, one head count says how many are pending, or the map says "at least 4,000" if that count fails.)* *(Corrected at fix pass 4: it said "more than 4,000". With exactly 4,000 pending and the count failed, that overclaims.)*;
  - tells a failed read (`error`, keeping what it read) and a capped one (`total` above what was read) from an empty queue. *(Corrected at fix pass 3: a server cutting responses shorter than a window was first reported as capped. Now the read pages on by keyset and stops only at an EMPTY window or the cap, so a short window is never mistaken for the end.)*;
  - treats a missing table (before `20260807`: Postgres 42P01, or PostgREST's own PGRST205 "Could not find the table …", through `lib/orgGraph.ts` `isMissingRelation`) as empty, not as an error; any other failure — a missing column included — is an error, never "nothing pending";
  - carries each pair's graph node ids (`nodeA` / `nodeB` = `doc:<id>`; both ends are NOT NULL document references by schema).
  `listPendingPairs` keeps its old contract as a wrapper (`:257`).
- The page reads it (`app/(protected)/graph/page.tsx:241`). A failed read is said on the map (`:1212`): "Proposed connections couldn't be loaded (…) — none are drawn; the review queue still has them." A read that failed partway draws the pairs it read and says so: "Only the first N proposed connections (the newest) could be loaded (…) — the rest are not drawn; the review queue still has them." A capped one is said too, counting the rows READ (the view draws those whose two ends it shows; the chip says how many): "N read (the newest) of M proposed connections." (`:1220`). *(Corrected at fix pass 3: the notes said "the most confident", the first build's order. They also appeared with Proposals off. Now they appear only while Proposals are on.)* The chip counts the queue: "9,000 connections awaiting review · 1 drawn here" (`:1262`). *(Corrected at fix pass 3: the first build showed the chip whenever the queue was non-empty, even with Proposals turned off. The base drew it only over drawn ghosts. That rule is restored, and the chip still counts the queue.)*
- Tests (fix pass): `graphPendingProposals.test.ts` "PostgREST's own missing-table answer (PGRST205) is also nothing pending — not an error", "a missing COLUMN is an error, never an empty queue (fails closed)"; `graphPageRender.test.ts` "says how many it loaded, never 'none are drawn' over the pairs it drew".

**Done-when.**
1. ✓ The reader distinguishes error, capped and empty; the page surfaces the first two.
2. ✓ The chip shows the true pending count (the reader's queue), not the drawn count.
3. ✓ The endpoints carry their kind as data (node ids from the reader); the kind is the schema's.

**Scope / residual.** `lib/linkProposals.ts` is I-08's (merged) file. The change is additive: a new reader and a wrapper that keeps the old contract. **Residual (added at fix pass 4): an index for one run's rows.** The rows one Find-connections run inserts share one `created_at`. Inside such a run, each keyset window still reads every remaining row of the run, and the RESTRICTIVE policy runs on each of them, because `proposed_links_org_status_idx` (org_id, status, created_at DESC) holds no `id`. For one run of 9,000 that is 9,000 + 8,000 + 7,000 + 6,000 rows over the four windows (measured on PG16: 9,000 for window 1, 8,000 for window 2). The fix is an index on (org_id, status, created_at DESC, id DESC). That needs a migration, which this package does not add. **Owner:** the next intelligence package that ships a migration touching `proposed_links`, or the user if they want it sooner. It is listed in `99-fix-sequencing.md`. The read is correct without it; only its cost inside one run's batch is unbounded by the window.

**I-14 fix pass 3 (2026-10-02).** Two of the final review's minors.
- **The read is cheap again.** *(Corrected at fix pass 4: cheaper, not cheap in every case. Inside one Find-connections run's batch each window still reads the run's remaining rows — the I-14 fix pass 4 note below.)* At `035207c`, `readPendingProposalPairs` ordered by `confidence` and paged by `range` with `count: "exact"`. `proposed_links` is indexed on (org_id, status, created_at DESC) (`supabase/migrations/20260807_link_proposals.sql:70-71`), not on `confidence`, so each of up to four windows sorted the whole pending queue. The RESTRICTIVE `proposed_links_read_endpoints` policy (`20261126`, LNK-4) ran on every row of the queue each time. The base issued one unordered LIMIT read. Now (`lib/linkProposals.ts:323`):
  - **Order and windows.** Windows of at most 1,000 rows, ordered `created_at` desc then `id` desc. Each window starts after the last row read: `created_at < c OR (created_at = c AND id < id)`, with the timestamp double-quoted because it carries `.`, `:` and `+`. Each window carries a LIMIT. *(Corrected at fix pass 4: this said "Each window is an index range with a LIMIT, and the policy runs only on rows the read walks". Measured on PG16 (the real index, both SELECT policies, 9,000 pending), it was not an index range. With spread timestamps, window 2 was planned as a BitmapOr and a sort of every remaining row, and the policy's subplans ran about 8,000 times. With one run's rows (one `created_at`), each window ran them over every remaining row of the run. Each later window now also carries `created_at <= c`. The I-14 fix pass 4 note below says what that bounds and what it does not.)*
  - **Stop and count.** The read stops at an empty window or at the cap. Below the cap the rows read are the count, with no count request. At the cap, ONE head count (`count: "exact", head: true`) gives the queue. If that count fails, `total` is null and the map says "at least 4,000". *(Corrected at fix pass 4: it said "more than 4,000", which overclaims when exactly 4,000 are pending.)*
  - **Kept.** GM-7's three answers stand. An error keeps what was read and says so, and `total` is null. A missing table (42P01 / PGRST205) is an empty queue. A missing column is an error. A capped read gives `total` above the rows read.
  - **Order of the drawing.** The first 4,000 are now the NEWEST, not the most confident, and the notes say so. The review queue (`/admin/proposed-links`) keeps its own strongest-first order (`listProposals`, LNK-10).
- **The chip follows the drawing.** Restored to the base's rule: the chip shows only when this view draws proposal ghosts, so never with Proposals off (`app/(protected)/graph/page.tsx:1259`). When shown, it counts the reader's queue (done-when 2). The error and capped notes likewise show only while Proposals are on (`:1208-1223`). Why not an explicit "N pending (hidden)" chip: done-when 2 asks for the true count on the chip, not a chip when nothing is drawn. With Proposals off there is no drawing to qualify. The queue stays one tab away on the same screen: the Intelligence strip's "Review" tab (`components/navigation/ViewTabs.tsx:113`).

Tests: `graphPendingProposals.test.ts`, rewritten for the keyset read:
- "orders by created_at desc (the index's column), then id desc — never by confidence, never by offset" (no data window asks for a count; renamed at fix pass 4 from "orders by the index's columns (created_at desc, id desc) …", since the index holds no `id`);
- "each window starts after the last row read, with the timestamp quoted (it carries . : +)";
- "rows sharing one created_at across a window edge are neither skipped nor read twice";
- "past the cap: draws the newest 4,000 and says how many are pending — one count, at the cap";
- "below the cap the read is the count: no count request at all, and nothing capped";
- "a server cutting responses shorter than a window is paged on, never reported complete over a cut set";
- "the count failing at the cap says 'at least the cap', never a wrong total" (renamed at fix pass 4 from "… 'more than the cap' …");
- "a row with no usable key ends the read with an error rather than looping".

`graphPageRender.test.ts` "GM-7 — the proposals chip follows what is drawn (fix pass 3)" has four cases: Proposals off with a 9,000 queue; Proposals off with a failed read; Proposals on with no ghost in the view; Proposals on, then toggled off in Settings. Negative controls: against `035207c`'s reader, 11 of the 15 reader cases fail. The order, keyset and count cases fail on the mechanism itself: a `confidence` order, `range` windows, a count on a data window. The rest fail because the stand-in serves keyset windows only. Against `035207c`'s page, all four chip cases fail. Line references in this record were remapped to the fix-pass-3 code.

**I-14 fix pass 4 (2026-10-07).** The re-review of fix pass 3 measured the keyset read on PG16, with the real `proposed_links_org_status_idx` and both SELECT policies, over 9,000 pending rows. The windows were not index ranges, as the code comment and this record had said. Reproduced first (DEC-29) on a scratch PG16 with synthetic rows, the same index and the same two policies:
- **Spread timestamps.** Window 2's `created_at < c OR (created_at = c AND id < x)` was planned as a BitmapOr of two bitmap index scans, then a heap scan and a sort. It read 8,000 rows, and the policy's subplans ran 8,000 times.
- **One Find-connections run.** `lib/linkProposerServer.ts:835` writes a run in one upsert, so every row it inserts shares one `created_at` (a stale row the upsert flips back to pending keeps its own). Window 1 read all 9,000 rows and window 2 read 8,000, the policy running on each, because the index holds no `id` to order the tie.

What changed (`lib/linkProposals.ts:332-337`): each window after the first also carries `.lte("created_at", last.created_at)`. The `or` already implies that bound, so it changes no row and no order. On the same data, window 2 with spread timestamps is now one index scan with `created_at <= c` as its index condition. It reads 1,001 rows and runs the policy 1,001 times, and returns the same 1,000 rows in the same order (checked with the two queries side by side). Inside one run's tie it changes nothing: each window still reads the remaining rows of the run in full. The order inside one run is uuid order (`id` desc), so "the newest" inside a run means uuid order, not write order. The index that would bound those reads is the residual above, with its owner. The comment above the reader (`:300-316`) says all this now.

Also: if the head count fails at the cap, the map says "N read (the newest) of at least 4,000 proposed connections." (`app/(protected)/graph/page.tsx:1221`), not "more than 4,000". The reader's `capped` comment says the same (`lib/linkProposals.ts:282-284`).

Tests:
- `graphPendingProposals.test.ts` "each later window also bounds the index range: created_at <= the last row's, beside the or (fix pass 4)". The first window has no bound; each later one has `lte("created_at", <the last row read>)` beside its `or`; the 2,500 rows come back in the same order. The stand-in now applies `lte` too, so every earlier case checks the bound changes no row.
- `graphPageRender.test.ts` "the count failing at the cap says 'at least' the cap — exactly 4,000 pending is not 'more than' (fix pass 4)".

Negative controls: without the `.lte`, the bound case fails and the other 15 pass. With "more than" restored, the page case fails. Line references in this record were remapped to the fix-pass-4 code.

---

<a id="gm-8"></a>

## GM-8 · Process-flow direction is destroyed by the undirected dedup key: A→B and B→A collapse into one edge, so every recycle loop disappears from the Process lens

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here two antiparallel confirmed flows assembled to one edge (`expected […] to have a length of 2 but got 1`). What landed in `lib/orgGraph.ts`: `DIRECTED_EDGE_TYPES = {flow, supersession}`; for those `addEdge` dedupes on the ORDERED key (`a|b|type`, a = source), every other type on the unordered pair; `GraphEdge` documents that a directional edge runs a → b. Non-confirmed flows are counted: "N process flows are proposed and awaiting review — not drawn (the operating area's flow panel lists them)." (dismissed flows are decisions, not counted).

Tests: `lib/__tests__/orgGraph.test.ts` — "A→B and B→A are two flow edges, each keeping its direction; a proposed flow is counted", "supersession is directional too; symmetric types still dedupe as a pair".

**Done-when.**
1. ✓ The dedup key for flow and supersession preserves order.
2. ✓ A test asserts that A→B and B→A both survive as distinct flow edges.
3. ✓ Proposed flows' count is reported in truncations.

**Scope / residual.** Drawing the direction (arrowheads on flow) is the renderer's — I-14 (FLOW-10 / GPV-8).

---

<a id="gm-9"></a>

## GM-9 · REGION_ANCHOR_ORDER omits "plot", so indexOf returns -1 and any plot-plan node always hijacks its region's name

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): the new case in `lib/__tests__/graphInsights.test.ts`, against the base `lib/graphInsights.ts`, names the region "Site Plot Plan Rev C". What landed: `REGION_ANCHOR_ORDER` (six entries, no "plot", ranked by `indexOf` = -1) is replaced by `REGION_ANCHOR_RANK: Record<GraphNodeType, number>` (unit 0 … plot 6); an unranked type would be a compile error, and the loop starts from +∞.

Tests: `graphInsights.test.ts` — a component holding a plot plan and a unit is named after the unit; a source pin that the rank table is a `Record<GraphNodeType, number>`.

**Done-when.**
1. ✓ Every GraphNodeType is ranked.
2. ✓ The table is a `Record<GraphNodeType, number>` — adding a node type without a rank fails to compile.
3. ✓ The test names the region after the unit.

**Scope / residual.** None.

---

<a id="gm-10"></a>

## GM-10 · The graph does not model an entire level of the plant hierarchy (systems) and never reads documents.plant_id or documents.system_id, despite both being persisted FK columns

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** intelligence I-14 GRAPH PAGE, LENSES & RENDERERS — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
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

**Partial (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here a system-filed drawing and a plant-filed standard had no scope tie and were orphans. What landed in `lib/orgGraph.ts`: documents.plant_id / system_id (and assets.plant_id / system_id) are selected and drawn as "unit"-class edges to `plant:` / `system:` nodes; the `systems` table (non-archived) is assembled, FOLDED into the unit node class (`system:<uuid>`, type "unit", sub "System …", `unitCode` of its mapped unit), each system hanging from its unit's node (systems.unit_id). The decision — no node type beyond these (the plan's WIRE-4 default; every renderer keys a Record on GraphNodeType) — is written in the module header and `DEC-67`.

Tests: `lib/__tests__/orgGraph.test.ts` GM-10 block (the system hangs from `cbunit:20`; the system- and plant-filed documents are tied and are not orphans).

**Done-when.**
1. ✓ documents.plant_id and documents.system_id are selected and drawn as unit-class edges to their plant / system nodes.
2. ✓ Systems are deliberately folded into units, documented in the module header.
3. **Not met here:** the lens presets are renamed to what they show — `app/(protected)/graph/page.tsx`, I-14's file (GPV-10 / GPV-4, the plan's lens-set decision).

**Scope / residual.** Remaining limb: I-14's lens rename. No migration is needed for this finding's half (the columns exist since 20260606); a system's unit is a codebook node only once 20261138's mapping is set.

**Resolution (2026-10-02, intelligence Round G).** The remaining limb: the lens presets are renamed to what they show. `lib/graphSettings.ts` `GRAPH_LENSES` holds the plan's lens set — 'Everything', 'Plant (units & equipment)', 'Equipment ↔ Documents', 'Documents & libraries' (`DEC-44 (I-14)`). Each title is true of its hidden list (`GPV-10`). Test: `lib/__tests__/graphSettingsUrl.test.ts` "each lens's hidden list produces exactly the node types its title names" and "no lens is named by a single node-type word, and none is named for what it hides".

**Done-when.**
1. ✓ (I-13) documents.plant_id / system_id are drawn.
2. ✓ (I-13) Systems are folded into units, documented.
3. ✓ The lens presets are renamed to what they show. The scope (one unit's world) is a separate control, the scope picker (`GPV-2`), not a lens.

**Scope / residual.** None in this package.

---

<a id="gm-11"></a>

## GM-11 · The same node shows two contradictory connection counts on one screen: NodePeek prints the full-graph degree, the Hubs list prints the filtered context degree

- **Severity:** LOW
- **Status:** RESOLVED
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

**Resolution (2026-10-02, intelligence Round G).** Reproduced first (DEC-29): base `components/graph/NodePeek.tsx:89` printed `node.degree` (the whole map, library filing included). Beneath it the list (`page.tsx:408-418`) and the Hubs number (`page.tsx:645`) counted the filtered context web. `graphPageRender.test.ts` "the peek labels …" fails against the base. What landed:
- The peek's header reads "Document · 3 links on the map (1 library filing) · 1 link in this view" (`components/graph/NodePeek.tsx:123`, props `viewDegree` / `libraryLinks`; the page computes both in `peekCounts`, `app/(protected)/graph/page.tsx:631`). *(Corrected at fix pass 3: it read "· 1 in this view", with no unit.)*
- The list header reads "Connected in this view · K nodes (J only by a proposed link) (the 12 most connected)" (`NodePeek.tsx:187`; the page computes K and J at `page.tsx:609`). *(Corrected at fix pass 3: it read "Connected in this view · K". That put two different numbers on one panel under the same "in this view" label. The header counts LINKS: edges, never a proposal ghost (`viewDegree`, `lib/graphView.ts:75`). The list counts distinct neighbour NODES, ghosts included. Each label now says what it counts.)*
- The Hubs panel says "The number is its links, not counting library filing", with the same tooltip on each count.

**Done-when.**
1. ✓ by its stated alternative (done-when 2): the numbers are not forced equal, they are labelled.
2. ✓ The whole map, its library-filing part and this view are labelled distinctly. A hub's number is the whole map less filing, and the peek shows both parts. *(Corrected at fix pass 3: as first ticked, this did not hold. The header's "N in this view" (links, no ghosts) and the list's "Connected in this view · K" (nodes, ghosts included) were different counts under one label. It holds since fix pass 3: "N links in this view" against "K nodes (J only by a proposed link)".)*
3. ✓ Node radius and mass (`Math.sqrt(n.degree)` in both renderers, the page's sim mass) and the peek's "links on the map" are the same number, `GraphNode.degree`.

**Scope / residual.** None.

**I-14 fix pass 3 (2026-10-02).** The final review found done-when 2 ticked over two numbers that were both labelled "in this view". The header's count came from `viewDegree(selected.id, view.edges)`: edges, without proposal ghosts. The list's count was the distinct neighbour nodes over `[...view.edges, ...view.ghosts]` (`035207c` `page.tsx:591-611`). With one tag to P-101 and one proposal to LOOSE-2, a document's peek said "1 in this view" above "Connected in this view · 2". The counts are kept as they are, because the header must count what `degree` and the radius count: links. Each label now says what it counts:
- the header: "· 1 link in this view" (`components/graph/NodePeek.tsx:126`);
- the list: "Connected in this view · 2 nodes (1 only by a proposed link)" (`NodePeek.tsx:187-194`). The page splits a neighbour reached by a drawn link from one reached only by a proposal ghost (`app/(protected)/graph/page.tsx:609-624`).

Tests: `graphPageRender.test.ts` "GM-11 — the peek's numbers say what each counts (fix pass 3)": "the header counts links (no proposal); the list counts nodes, naming those tied only by a proposal" and "with no proposal, the list names no proposal part". Both fail against `035207c`'s page and peek. The older case "the peek labels the whole-map degree, the library-filing part and the in-view count" now expects "· 1 link in this view". The record is corrected in place per DEC-29 rule 3, and GM-11 stays RESOLVED on the corrected done-when 2.

---

<a id="gm-12"></a>

## GM-12 · The whole graph is rebuilt in the browser on every mount — up to ~47 HTTP round trips and ~48,000 rows, with five sequential eight-deep pagination chains

- **Severity:** LOW
- **Status:** WONTFIX
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

**Resolution (2026-10-01, intelligence Round G) — WONTFIX for now (DEC-28; the plan's default).** Real, as the verifier corrected it: the graph is assembled in the browser on every mount (about 14 requests for a typical org, up to ~56 at the caps), and the sessionStorage snapshot is skipped above 2 MB. Not built now:
- **Cost.** A server-assembled graph must re-implement, per caller, every document ACL rule the client read gets from RLS for free — `node_visible`, plus the app-enforced allow lists and role / team denies (this report's "already there" row on documents_acl_select warns exactly this) — for every table it reads, and add a cache with invalidation. That is a security-sensitive rewrite, and the page that would call it is I-14's file.
- **Alternative rejected.** Moving assembly behind `supabaseAdmin` this round without that ACL work — it would hand restricted drawings to every member.
- **What this round did to the cost instead.** Link tables page in keyset order (no 8-deep overlapping OFFSET windows); knowledge mirrors are read by id, only those the mentions point through; and `buildOrgGraph(orgId, { scope })` (GAP-306, `lib/scope.ts`) assembles one unit's world instead of the org's — the load most large orgs need.
- **What would change the answer.** A measured slow load on a real plant (none was observed — the finding is SUSPECTED), or a server-side per-caller document-ACL helper equal to the documents RLS predicate (I-12's chain work).

Follow-up recorded as `GAP-313` (90-gap-register.md — server-assembled graph).

**Done-when.**
1. Not done — WONTFIX for now (above); carried by GAP-313.
2. Not done — the snapshot path is the page's (I-14); GAP-313's acceptance carries it.
3. Not done — the page comment is the page's (I-14).

**Scope / residual.** GAP-313.

---

<a id="gm-13"></a>

## GM-13 · Three of the five paged join tables never report their truncation, and the kdoc mirror cap turns dropped mentions into a false explanation — contradicting the module's own stated contract

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-01, intelligence Round G).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` run against the base commit's `lib/orgGraph.ts` (57609d2) fails 23 of its 24 cases, each on a finding's own mechanism — here capped supersessions / curated links / flows produced no note, and with 6,000 mirrors the 5,000-row mirror cap announced a mirrored CONTROLLED drawing's mention as "library-only". What landed in `lib/orgGraph.ts`:
- every `pageRows` result's `capped` flag pushes a truncation that says what was read of how many — equipment-tag, project, curated document, supersession, mention and process-flow links (the last is FLOW-9's orgGraph half);
- every list read reaches `cap + 1` rows and reports when the cap is exceeded (documents, equipment, libraries, projects, plot plans — the 300-row caps included). *Corrected at review (2026-10-01):* the documents (`limit(1501)`) and equipment (`limit(2001)`) reads were single requests, which PostgREST cuts at max-rows (1,000), so their caps could never be reported; they are now read in windows of at most 1,000 rows, and the operational units, plants, systems and codebook units — unpaged in the first cut — are paged with their cap said (GM-3's correction, `readStructure`);
- the knowledge-mirror map is no longer a capped slice: only the mirrors the mentions point through are read, by id, to completion (`resolveMirrors`), so "N mentions come from library-only documents" counts only knowledge documents whose source_document_id is NULL; a mirror that cannot be read is said separately ("… could not be loaded — their mention links are not drawn"). `OrgGraph.mentionCoverage` reports rows read, edges drawn, unmapped and capped (IRLS-14's lib half). Review fix (2026-10-01): on a scoped graph `installed` is false when ANY of the three mention reads (by asset, by document, through mirrors) finds the table missing — a read with no ids issues no request and cannot see a missing table, so a unit with paper but no filed equipment read "installed" on an org without the mention index (test: `lib/__tests__/scope.test.ts`, "mention coverage …").

Tests: `lib/__tests__/orgGraph.test.ts` GM-13 block — 8,003 supersessions / curated links / flows each say "8,000 of 8,003 read"; 6,000 mirrors: the controlled drawing's mention is drawn and only the true library-only one is announced.

**Done-when.**
1. ✓ Every pageRows result's `capped` flag pushes a truncation, and every capped read reports when its cap is reached — no request asks for more rows than one PostgREST response carries (corrected at review: the documents and equipment caps were unreachable behind max-rows; the structure reads were unpaged).
2. ✓ The mirror map is resolved to completion for every mention that needs it, so the unmapped message can only be true.
3. ✓ A test asserts capped supersessions / related / flows produce truncation strings.

**Scope / residual.** None in the assembly. FLOW-9's other half (`lib/processFlows.ts` `listProcessFlows`) is I-09's.

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
