# 08 · Graph lenses & the missing scope pivot

**14 findings** — 1 CRITICAL · 2 HIGH · 11 MEDIUM.

**Your pivot complaint,** traced to the render layer.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| GraphSim — one force engine shared by both renderers, with deterministic id-seeded positions, a spatial-hash repulsion, live-tunable params, and a genuine 2D↔3D inflate/flatten that preserves neighbourhoods | `lib/graphSim.ts:72-94, 127-191, 205-275` | This is the strongest piece of the graph and it is pure, DOM-free and unit-testable. seedPosition's sqrt/cbrt radius warping (so points fill a disc/ball rather than a shell) and setDimensions' bearing-preserving inflate are the reason mode switching feels like lifting the same map rather than rebuilding it. Any scope-pivot work should feed it a different node set, not touch it. |
| buildOrgGraph's edge discipline — every edge is a real row, addEdge dedupes and refuses dangling endpoints, optional feature tables degrade to fewer edges instead of a broken page, and every cap is reported to the user | `lib/orgGraph.ts:1-18, 75-94, 149-155, 173-181, 306-315` | pageRows swallowing 42P01 ("pre-migration tables just contribute nothing") and the truncations array are why this page works across orgs at different migration levels. The unmapped-mention notice is a model of honesty ("N mentions come from library-only documents with no controlled counterpart"). Adding scoping keys to GraphNode extends this without disturbing it. |
| computeInsights — orphans/hubs/bridges/regions as pure analysis with an iterative Tarjan that correctly handles parallel edges via a multiplicity map | `lib/graphInsights.ts:39-48, 79-90, 111-148` | Bridge detection that respects multiplicity (a pair connected twice can never be a bridge) and library-edge exclusion from the "meaningful web" are both non-obvious and correct. Regions are what make the zoomed-out map readable. This is the analysis half of the answer to 'is the graph comprehensive enough' and it is sound; the gap is upstream, in what gets assembled. |
| NodePeek — walking the web without leaving the map, with quoted mention evidence, a back stack, and a cancellable per-node evidence load | `components/graph/NodePeek.tsx:3-14, 56-70, 96-140` | The 'why is this connected' quote with an unreviewed-confidence badge is the thing that makes links trustworthy in a PSM context. The `live` guard on the evidence fetch means fast walking never lets a stale response overwrite a newer node. Any scope pivot should be enterable from here. |
| OrgGraph3D's picking and hover discipline — NDC always derived from the event that asked, hover raycast on pointermove rather than per frame, and graceful WebGL/import failure with a message pointing at the 2D map | `components/graph/OrgGraph3D.tsx:286-305, 360-368, 149-167` | The comment 'a tap fires no pointermove, so a stale position means taps and clicks silently resolve nothing' records a real bug that was fixed; do not regress it. The two failure paths mean the 3D toggle can never brick the page. |
| The Operating Areas page already implements the exact unit pivot the graph lacks, and it is URL-addressable | `app/(protected)/admin/assets/page.tsx:3-10, 88-89, 139` | `?unit=<code>` scopes equipment-by-type, pinned libraries/folders and referencing documents to one operating unit — shareable, bookmarkable, already built. The graph's cbunit href points at it (lib/orgGraph.ts:201). The scope pivot on the graph should adopt this same key and namespace rather than inventing a second one. |
| Stale-while-revalidate graph load with a size-guarded sessionStorage snapshot, and separate persisted 2D/3D layouts | `app/(protected)/graph/page.tsx:102-132, 148, 184-202` | Painting the last-built graph instantly while a dozen parallel table pulls land, and refusing to cache oversized graphs rather than fighting the quota, is why the page feels fast. The separate posKey per dimensionality ('restoring a flat disc into the 3D view guarantees a pancake') is a fix worth keeping. |


---


<a id="gpv-1"></a>

## GPV-1 · /api/graph/ask runs the corpus search as service role and never applies the per-asker ACL filter — the graph's Ask box reads every ACL-protected controlled document in the org

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/graph/ask/route.ts:83-87`, `app/api/graph/ask/route.ts:21-23`, `supabase/migrations/20260917_knowledge_sources.sql:69-82`, `supabase/migrations/20260929_mention_engine.sql:112-134`, `app/api/knowledge/ask/route.ts:157-186`

**Mechanism.** The route's own header comment asserts the security model: "the corpus RPC runs SECURITY INVOKER under the caller's own RLS, so this can never widen what the person is allowed to read." But the call is `supabaseAdmin.rpc("graph_ask", …)` and `lib/supabaseAdmin.ts` builds that client from `SUPABASE_SERVICE_ROLE_KEY`. SECURITY INVOKER therefore resolves to the SERVICE ROLE, for which RLS does not apply. The RLS policy this is supposed to be constrained by is explicit about the contract it expects: migration 20260917 comments "Linked chunks mirror ACL-protected controlled documents, so direct reads are closed; the ask API (service role) filters them per asker", and the policy body is `EXISTS (org_members …) AND NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = knowledge_chunks.document_id AND d.source_document_id IS NOT NULL)`. `/api/knowledge/ask` honours that contract — it calls `loadPrincipal` + `readableControlledDocIds` and builds `excludedDocIds`, failing closed (`catch { excludedDocIds = new Set(linkedDocs.map(...)) }`). `/api/graph/ask` implements no equivalent: its only gate is `org_members … status='active'` (lines 74-77). It then also fans out with `supabaseAdmin` to `entity_mentions` and `knowledge_documents` (lines 137-172), returning `documentName`, `page`, and a `ts_headline` snippet of the chunk body.

**Failure scenario.** A Viewer-role member with no ACL grant on the restricted Legal/HSE library opens /graph, types "settlement terms" and presses Enter. graph_ask matches chunks whose parent knowledge_document has a non-null source_document_id pointing at a controlled document they cannot open. The answer panel (app/(protected)/graph/page.tsx:796-812) renders the document name, the page number and a 42-word ts_headline excerpt of the restricted text, plus an "Open at page N" link. The same user asking the identical question through /knowledge/[id] gets nothing, because that route excludes the doc.

**Evidence.**

```
app/api/graph/ask/route.ts:21-23 — "Security: org membership is checked here, and the corpus RPC runs SECURITY INVOKER under the caller's own RLS, so this can never widen what the person is allowed to read." vs line 83 `const { data: rawHits, error: askErr } = await supabaseAdmin.rpc("graph_ask", {`. supabase/migrations/20260917_knowledge_sources.sql:71-72 — "Linked chunks mirror ACL-protected controlled documents, so direct reads are closed; the ask API (service role) filters them per asker." app/api/knowledge/ask/route.ts:157-160 — "Per-asker ACL filter over source-linked documents … Fails CLOSED".
```

**Done when.**

- [ ] /api/graph/ask resolves the asker's principal and excludes knowledge_documents whose source_document_id is not in readableControlledDocIds, using the same helper pair as app/api/knowledge/ask/route.ts:172-181
- [ ] the filter fails closed: if the readable set cannot be computed, every source-linked knowledge document is excluded from hits, nodeIds and assets
- [ ] the entity_mentions and knowledge_documents fan-out at lines 137-172 is restricted to the surviving kdocIds, so a hidden document cannot leak via nodeIds or the asset snippet
- [ ] the route header comment is rewritten to describe what the code actually does
- [ ] an authorization test asserts that a member with no ACL grant on a source-linked library gets zero hits for a term that only appears in that library

---

<a id="gpv-2"></a>

## GPV-2 · A GraphNode carries no structured scoping key at all — the "crude unit: all of this goes here" pivot cannot be built without changing the assembly, not the UI

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:37-44`, `lib/orgGraph.ts:109-117`, `lib/orgGraph.ts:222-250`, `lib/graphSettings.ts:22-52`, `app/(protected)/graph/page.tsx:151-180`

**Mechanism.** `GraphNode` is exactly `{ id, type, label, sub?, href, degree }`. Every scoping key the queries already fetch is thrown away at node-construction time. For documents the select is `id, document_number, title, library_id, unit_id, sheet_number, sheet_total` (line 109-111) — `library_id` survives only as substring of the `href` string (`/documents/${d.library_id}?doc=${d.id}`), and `unit_id`, `sheet_number`, `sheet_total` survive only as an edge or an interpolated label. For assets the select is `id, tag, description, unit_code, unit_id` (line 114-116) — `unit_code` and `unit_id` become edges and nothing else. The assets table also holds `plant_id`, `system_id`, `type_id`, `location`, `library_id` (supabase/migrations/20260603_asset_registry.sql:29-46 plus the ALTERs) and none of those are even selected. `GraphSettings` has `hiddenTypes`, `showLibraryEdges`, `hideUnlinked`, `showProposals`, colour `groups`, display/force sliders and `localDepth` — no scope, no subtree, no unit field. The only scoping primitive that exists is `focusId` + `neighborhood()` (page.tsx:169-174), which is topological (N hops through whatever edges survive the type filter), not structural. Consequently a scope pivot today can only be approximated by focusing a `cbunit:` node at depth 1, which reaches its assets but not their documents, and at depth 2, which reaches those documents plus every OTHER asset any of those documents touch — i.e. it leaks straight out of the unit.

**Failure scenario.** An engineer wants the map to show only Unit 20 (Crude). There is no control for it. They focus `cbunit:20` at localDepth 1 and get the unit's equipment with zero drawings. They raise localDepth to 2 and the view now includes every P&ID touching that equipment plus, through those P&IDs, equipment in Units 30 and 44 — a bigger map than they started with. Meanwhile /admin/assets?unit=20 already renders the correct scoped view (equipment by type, pinned libraries, referencing documents), and the graph's own cbunit href points there (lib/orgGraph.ts:201) — the graph's answer to "scope to a unit" is "leave the graph".

**Evidence.**

```
lib/orgGraph.ts:37-44 — `export interface GraphNode { id: string; type: GraphNodeType; label: string; sub?: string; href: string; degree: number; }`. lib/orgGraph.ts:222-227 builds the asset node from a row that has `unit_code` and `unit_id` in hand and keeps neither. Three differently-shaped searches for a scope filter (`grep scope` over the five graph files; `grep -i scopeTo|scopedTo|unitFilter|subtree|restrictTo|onlyUnit` repo-wide; `grep -i pivot` repo-wide) found only the word "PIVOTS" in the LENSES comment at page.tsx:426 and `unitFilter` in app/(protected)/admin/assets/page.tsx:88.
```

**Done when.**

- [ ] GraphNode gains explicit optional scoping fields — at minimum `unitCode`, `unitId`, `plantId`, `libraryId`, `systemId`, `sheetNumber` — populated in lib/orgGraph.ts from rows already being selected, plus plant_id/system_id/type_id added to the assets select
- [ ] GraphSettings gains a scope descriptor (e.g. `{ kind: "unit"|"plant"|"library"|null, key: string|null }`) distinct from focusId
- [ ] the view memo in app/(protected)/graph/page.tsx filters nodes by that scope structurally (a document is in scope if its unitCode matches OR it is edged to an in-scope asset), independent of hop distance
- [ ] the scope is settable from a cbunit/plant node in NodePeek and from a control in the top bar, and its active state is shown the way the Focused chip is (page.tsx:498-505)

---

<a id="gpv-3"></a>

## GPV-3 · No document is ever edged to a Site Codebook unit — the two "unit" node families are disjoint, so a unit-scoped view of the paper is two hops away and mediated by equipment

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:253-261`, `lib/orgGraph.ts:190-203`, `lib/orgGraph.ts:284-289`, `supabase/migrations/20260606_operational_entity_graph.sql:52-65`, `lib/codebook.ts:1-10`

**Mechanism.** buildOrgGraph creates two disjoint node families that both carry `type: "unit"`: `unit:<uuid>` from the `units` table (plant hierarchy) and `cbunit:<code>` from the Site Codebook. The only document→unit edge is `if (d.unit_id) addEdge("doc:"+d.id, "unit:"+d.unit_id, "unit")` (line 259) — it targets the LEGACY family. Assets edge to BOTH (`a.unit_code` → cbunit, `a.unit_id` → unit, lines 254-257). Process flows resolve unit endpoints only to cbunit (`flowNodeId` line 284-285). No edge is ever created between a `unit:` node and a `cbunit:` node, in either direction. So the graph holds two parallel, unlinked answers to "which unit is this", and the one the registry and the codebook actually browse by (cbunit — orgGraph.ts:198-202 hrefs to `/admin/assets?unit=<code>`) has no documents attached to it at all.

**Failure scenario.** A user clicks the "Crude Unit" cbunit node and hits Go in at depth 1. They see the unit's equipment and no drawings — because every document's unit tie points at `unit:<uuid>`, a different node that may also be labelled "Crude Unit" and sits somewhere else on the map. If both families are populated the map shows "Crude Unit" twice, in the same violet, under the same "Units" filter checkbox, distinguishable only by the sub line ("U100" vs "Unit 20").

**Evidence.**

```
lib/orgGraph.ts:259 `if (d.unit_id) addEdge(\`doc:${d.id}\`, \`unit:${d.unit_id}\`, "unit");` — the sole doc→unit edge. lib/orgGraph.ts:198-202 creates cbunit nodes with `type: "unit"`. supabase/migrations/20260606_operational_entity_graph.sql:57 — `code TEXT, -- "U100", "U200"`; lib/codebook.ts:3-4 — `units ("20" = Crude)`. Two different code namespaces, both rendered as "Units".
```

**Done when.**

- [ ] documents.unit_id rows are bridged to their codebook unit (or the legacy unit node is edged to the matching cbunit node), so one unit identity is reachable from both sides
- [ ] or the two families are visually and structurally distinguished — different node types/labels — so a user can tell which "Crude Unit" they are looking at
- [ ] a cbunit node at depth 1 reaches the documents scoped to that unit

---

<a id="gpv-4"></a>

## GPV-4 · "Equipment" names three different things on the same screen; "Units" names two disjoint node families

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:45-48`, `app/(protected)/graph/page.tsx:431`, `components/graph/GraphControls.tsx:22-26`, `components/graph/GraphControls.tsx:153`, `components/graph/NodePeek.tsx:88-90`, `app/(protected)/graph/page.tsx:864`

**Mechanism.** `TYPE_LABELS` maps the node type `asset` to the display string "Equipment" in two places (page.tsx:46 and GraphControls.tsx:23). The Filters drawer therefore has a checkbox labelled "Equipment" that means the node type. The top bar has a lens button labelled "Equipment ↔ Docs" that means a hidden-type preset. NodePeek prints `labelFor(node.type)` — "Equipment" singular via `.replace(/s$/, "")` (page.tsx:864) — as the node's kind, and its primary action reads "Open equipment". Unchecking the "Equipment" filter while the "Equipment ↔ Docs" lens is lit produces an Equipment lens showing no equipment, and the lens stays lit until the set-equality check fails. Separately, the same "Units" filter checkbox governs both the legacy `unit:` family and the codebook `cbunit:` family (both `type: "unit"`, both `NODE_COLORS.unit` violet), which are structurally unrelated (see the disjoint-unit finding).

**Failure scenario.** A user is told "turn on the Equipment lens". They open Settings, find the row labelled Equipment, and toggle it — the opposite of what was meant. The count next to it (`counts[t]`, computed over the unfiltered graph at page.tsx:244-249) reads e.g. 2000 while the map shows a third of that under a lens, with no note that the two numbers count different sets.

**Evidence.**

```
app/(protected)/graph/page.tsx:46 — `document: "Documents", asset: "Equipment", unit: "Units",`. app/(protected)/graph/page.tsx:431 — `label: "Equipment ↔ Docs"`. components/graph/GraphControls.tsx:153 — `<span …>{TYPE_LABELS[t]}</span>` rendering "Equipment" as the checkbox label.
```

**Done when.**

- [ ] the lens names and the node-type names occupy different vocabularies (e.g. lens "Governing paper", type "Equipment")
- [ ] the two unit families are labelled distinguishably in the Filters list and coloured or shaped differently on the map
- [ ] the Filters counts state whether they count the whole graph or the current view

---

<a id="gpv-5"></a>

## GPV-5 · A ?focus= deep link re-selects and re-flies the camera on every settings change — dragging any slider yanks the view back and re-opens the peek

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:226-237`, `app/(protected)/graph/page.tsx:151-180`, `app/(protected)/graph/page.tsx:134-140`, `components/graph/OrgGraph2D.tsx:63-79`, `components/graph/OrgGraph3D.tsx:510-527`

**Mechanism.** The deep-link effect declares `[focusParam, view]` as its dependencies. `view` is a `useMemo` over `[graph, settings, proposals, focusId]`, and `patchSettings` produces a brand-new settings object on every call — which is every `onChange` tick of every slider in GraphControls (they are `type="range"` with live onChange, by design: "every force is live"). So each frame of a slider drag rebuilds `view`, re-runs the effect, and calls `setSelected(node)` plus `setHighlight({ ids: [id], nonce: Date.now() })`. Both renderers treat a changed `flyTo` as a camera command — OrgGraph2D sets `camTargetRef.current` on every `flyTo` identity change, OrgGraph3D re-flies whenever `fly.nonce !== lastFly`. The param is never stripped from the URL, so the behaviour persists for the whole visit.

**Failure scenario.** A user arrives from /admin/assets via `/graph?focus=asset:abc`, closes the peek, and drags the Repel force slider to spread the map out. The peek pops back open and the camera lurches back to that one asset on every pixel of the drag. The only escape is to hand-edit the URL.

**Evidence.**

```
app/(protected)/graph/page.tsx:237 — `}, [focusParam, view]);`. app/(protected)/graph/page.tsx:180 — `}, [graph, settings, proposals, focusId]);`. app/(protected)/graph/page.tsx:135-138 — `setSettings((prev) => { const next = { ...prev, ...patch }; … return next; });`. components/graph/OrgGraph3D.tsx:512 — `if (fly && fly.nonce !== lastFly && fly.ids.length > 0) {`.
```

**Done when.**

- [ ] the deep-link effect fires once per focusParam (guard on a consumed ref, or depend on the node id rather than the whole view object)
- [ ] the param is cleared from the URL after it is honoured, or honouring it is idempotent
- [ ] dragging a force slider never moves the camera

---

<a id="gpv-6"></a>

## GPV-6 · Assets, libraries, projects and plot plans are capped with LIMIT and no ORDER BY — which equipment appears on the map is nondeterministic between loads

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:107-117`, `lib/orgGraph.ts:137`, `lib/orgGraph.ts:141-143`, `lib/orgGraph.ts:164-165`, `app/(protected)/graph/page.tsx:110-123`

**Mechanism.** The documents query is explicitly ordered — `.order("updated_at", { ascending: false, nullsFirst: false }).limit(DOC_CAP)` — and the truncation notice honestly says "Showing the 1500 most recently updated documents." Every other capped query omits ORDER BY: assets `.eq("archived", false).limit(2000)`, libraries `.limit(300)`, projects `.limit(300)`, plot_plans `.limit(300)`, knowledge_documents `.limit(5000)`. Postgres row order without ORDER BY is not defined and shifts with plan choice, vacuum and heap churn. The truncation string still claims determinism: "Showing the first 2000 equipment items." There is no "first". Compounding it, the page caches the built graph in sessionStorage (`org-graph-${activeOrgId}`) and paints that stale slice before the fresh build swaps in, so the two visible populations in one session can differ.

**Failure scenario.** A plant with 3,400 registry assets opens /graph. E-2201 is on the map. A colleague opens it and E-2201 is absent while E-4410 (which the first user never saw) is present. Neither user is told that the equipment set is a random 2,000 of 3,400 — the amber chip says "the first 2000". The Insights → Orphans list, computed over that arbitrary slice, therefore names different orphans on each load, which makes it useless as a remediation worklist in a PSM context.

**Evidence.**

```
lib/orgGraph.ts:114-117 — `supabase.from("assets").select("id, tag, description, unit_code, unit_id").eq("org_id", orgId).eq("archived", false).limit(ASSET_CAP)` (no .order). Contrast lib/orgGraph.ts:109-113 which does order. lib/orgGraph.ts:165 — `truncations.push(\`Showing the first ${ASSET_CAP} equipment items.\`)`.
```

**Done when.**

- [ ] every capped query carries a deterministic ORDER BY (assets by tag or updated_at, libraries/projects/plots by name)
- [ ] the truncation copy matches the actual ordering rule for each list
- [ ] or the caps are removed in favour of the scope pivot, so a unit-scoped map loads that unit's full population rather than a random org-wide slice

---

<a id="gpv-7"></a>

## GPV-7 · Drawing a flow between two legacy unit nodes writes the wrong namespace and the edge silently disappears on reload

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:319-346`, `lib/orgGraph.ts:284-289`, `lib/orgGraph.ts:173-181`, `lib/orgGraph.ts:192-194`, `lib/processFlows.ts:52-70`

**Mechanism.** In `completeConnect`, `unitCode(n)` returns `n.id.slice(7)` for a `cbunit:` node but `n.sub ?? null` for a `unit:` node. For a legacy unit node, `sub` was set from `units.code` (orgGraph.ts:192-194), documented in the schema as "U100", "U200" — a different namespace from the codebook codes ("20"). `createManualFlow` then inserts `from_ref: "U100"` with `from_kind: "unit"`. On the next `buildOrgGraph`, `flowNodeId("unit", "U100")` returns `"cbunit:U100"`, and `addEdge` opens with `if (a === b || !nodes.has(a) || !nodes.has(b)) return;` — the node does not exist, so the edge is dropped without a word. The user does see the edge immediately, because line 344 optimistically pushes `{ a: "unit:<uuid>", b: "unit:<uuid>", type: "flow" }` into local state. A second, quieter case: a legacy unit with a NULL `code` has `sub === undefined`, so `unitCode` returns null and the Connect button offered at page.tsx:871 (which whitelists the `unit:` prefix) can never succeed — the user gets the generic "Draw a link between two documents…" error.

**Failure scenario.** An operator opens Connect on the "Crude Unit" legacy node, clicks "Coker", sees "Connected Crude Unit ↔ Coker (flow) ✓" and a cyan line appear. They refresh. The line is gone. The process_flows row still exists in the database, status 'confirmed', pointing at a unit ref no consumer resolves — a phantom row that will never render and never be re-proposed (the reader treats existing rows as decided).

**Evidence.**

```
app/(protected)/graph/page.tsx:319-322 — `const unitCode = (n: GraphNode): string | null => n.id.startsWith("cbunit:") ? n.id.slice(7) : n.id.startsWith("unit:") ? (n.sub ?? null) : null;`. lib/orgGraph.ts:284-285 — `const flowNodeId = (kind: string, ref: string) => kind === "asset" ? \`asset:${ref}\` : \`cbunit:${ref}\`;`. lib/orgGraph.ts:174 — `if (a === b || !nodes.has(a) || !nodes.has(b)) return;`.
```

**Done when.**

- [ ] unit↔unit Connect either resolves a legacy unit to its codebook code before writing, or is refused with an explicit message naming why
- [ ] the optimistic edge pushed at page.tsx:344 uses the same node ids the rebuild will produce, so a refresh never contradicts the confirmation
- [ ] the Connect button is not offered on unit nodes whose flow endpoint cannot be resolved
- [ ] existing process_flows rows whose unit refs resolve to no node are surfaced somewhere rather than silently dropped by addEdge

---

<a id="gpv-8"></a>

## GPV-8 · Flow is the one edge type whose meaning is direction, and neither renderer ever draws an arrow on it; 3D ignores the arrow and curve settings entirely; there is no legend for ten edge colours

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/graph/OrgGraph2D.tsx:202`, `components/graph/OrgGraph3D.tsx:601-634`, `components/graph/graphTheme.ts:20-44`, `components/graph/GraphControls.tsx:213-217`, `app/(protected)/graph/page.tsx:849-852`

**Mechanism.** 2D draws arrowheads only when `st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath)`. `flow` is absent from that list, even though the Connect panel tells the user the semantics explicitly — "Equipment ↔ equipment or unit ↔ unit makes a FLOW — the first feeds the second" — and lib/processFlows.ts opens with "A flow is a DIRECTIONAL edge". In 3D nothing is drawn but line segments: a repo-wide grep for `showArrows|curvedLinks` finds them in graphSettings.ts (definitions), GraphControls.tsx (the two toggles) and OrgGraph2D.tsx (the two uses) — and nowhere in OrgGraph3D.tsx. So both toggles are inert in 3D while remaining visibly present in the drawer. Separately, `EDGE_LABELS` — the human names for all ten edge types — is imported in exactly one place, app/(protected)/graph/page.tsx:263, to write the `via` string in the path panel. A grep for "legend" across app/(protected)/graph/ and components/graph/ returns nothing. The map paints ten distinct edge colours (slate, violet, amber, rose, deep violet, slate, gold, emerald, cyan, fuchsia) with no key, and ACCENT.path (#22d3ee) is a near-neighbour of the flow colour (#06b6d4), so a highlighted path and a process flow read as the same cyan.

**Failure scenario.** An operator switches to the Process lens to read the plant as flow, and sees an undirected cyan mesh. Whether the reactor feeds the exchanger or the reverse is unreadable on the map; they have to click each edge's endpoints and reason about which was clicked first in Connect. They toggle Arrows on hoping to fix it — in 3D nothing happens; in 2D nothing happens either, because flow is not in the arrow whitelist.

**Evidence.**

```
components/graph/OrgGraph2D.tsx:202 — `if (st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath)) {`. lib/processFlows.ts:3 — "A flow is a DIRECTIONAL edge: something feeds something else." grep `showArrows|curvedLinks` over components/ lib/ app/: six hits, none in OrgGraph3D.tsx. grep `EDGE_LABELS` repo-wide: definition plus one usage at page.tsx:263. grep -i `legend` over the graph page and components/graph/: no results.
```

**Done when.**

- [ ] flow edges render a direction indicator in 2D and 3D
- [ ] the Arrows and Curved-links toggles either work in 3D or are hidden/disabled when mode is 3d
- [ ] a legend keyed off EDGE_LABELS + EDGE_RGB is reachable from the map, and the path accent is separated from the flow colour

---

<a id="gpv-9"></a>

## GPV-9 · Focus mode computes each node's hop distance and throws it away — no depth fade, and the depth control is filed under "Forces"

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/graphSim.ts:289-309`, `app/(protected)/graph/page.tsx:168-174`, `components/graph/GraphControls.tsx:224-238`, `components/graph/OrgGraph2D.tsx:236-241`, `components/graph/OrgGraph3D.tsx:575-579`

**Mechanism.** `neighborhood()` returns `Map<string, number>` and its docstring states the intent: "Every node within `depth` hops of a root — Obsidian's local graph, but it also reports HOW FAR each node is so the renderer can fade by distance." The consumer uses only membership: `const near = neighborhood(...); nodes = nodes.filter((n) => near.has(n.id));`. The distance is never passed to either renderer, and neither renderer accepts a depth map — their dimming is driven by hover/selection adjacency (`spotId`, `neighbours`) and by search misses, not by focus depth. The result is that a depth-3 focus is a hard-edged blob in which a node three hops out looks identical to the root's immediate neighbour, and the only cue to where the edge of the neighbourhood is is the chip text. The control that governs this (`localDepth`) sits in the Forces section of the drawer, beneath four physics sliders, labelled "Neighbourhood depth" — it is a filter, not a force, and a user hunting for it in Filters will not find it.

**Failure scenario.** An engineer focuses a hub asset at depth 3 to see its blast radius. Every one of the 200 surviving nodes renders at full weight; they cannot tell which are directly governed and which are three removes away. They want to reduce the depth, look in Filters, find nothing, and conclude the depth is fixed.

**Evidence.**

```
lib/graphSim.ts:289-291 — "…but it also reports HOW FAR each node is so the renderer can fade by distance." app/(protected)/graph/page.tsx:170-171 — `const near = neighborhood(focusId, buildAdjacency(edges), settings.localDepth); nodes = nodes.filter((n) => near.has(n.id));`. components/graph/GraphControls.tsx:235-237 places the localDepth Slider inside `<Section icon={Waves} title="Forces">`.
```

**Done when.**

- [ ] the depth map is threaded to the renderers and used to fade or shrink nodes by hop distance in both 2D and 3D
- [ ] the depth control moves into Filters (or a Focus section) next to the thing it filters
- [ ] the Focused chip's depth is adjustable in place rather than only through the drawer

---

<a id="gpv-10"></a>

## GPV-10 · Lens titles describe views the lenses do not produce, and the whole lens row is invisible below 640px

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:428-433`, `app/(protected)/graph/page.tsx:486-496`, `app/(protected)/graph/page.tsx:434-437`

**Mechanism.** Each lens is a subtraction list, and two of them subtract the wrong set for their own copy. "Process" hides `["document","library","project","plot"]` and is titled "Units and equipment only — the plant as flow" — but `plant` is not hidden, so grey plant nodes remain on a lens that says it shows only units and equipment. "Equipment ↔ Docs" hides `["unit","plant","project","library"]` and is titled "Equipment and the documents that govern it" — but `plot` is not hidden, so fuchsia plot-plan nodes and their edges are in the view. Activation is detected by exact set equality plus the libEdges flag (434-437), so a user who adjusts one checkbox in the Settings drawer instantly deselects every lens with no indication of which one they had drifted from, and clicking a lens silently overwrites their hand-tuned hiddenTypes with no undo. The row itself is `className="hidden sm:flex …"`, so on a phone — the device most likely to be in a field engineer's hand — the pivot control does not exist at all and only the drawer checkboxes remain.

**Failure scenario.** An engineer taps Process to see the plant as flow and gets units, equipment, plants, and (because plants survive) an extra grey hub pulling the layout. They open Settings and uncheck Plants themselves; the Process button immediately goes un-highlighted even though the view is now closer to what Process claims to be. On a phone they never see the row at all.

**Evidence.**

```
app/(protected)/graph/page.tsx:430 — `{ key: "process", label: "Process", hidden: ["document", "library", "project", "plot"], libEdges: false, title: "Units and equipment only — the plant as flow…" }`. Line 431 — `{ key: "equipment", …, hidden: ["unit", "plant", "project", "library"], title: "Equipment and the documents that govern it" }`. Line 486 — `<div className="hidden sm:flex items-center rounded-full …">`.
```

**Done when.**

- [ ] each lens's hidden list actually produces the view its title describes, or the titles are rewritten to match
- [ ] the lens row is reachable on small screens (a select, a sheet, or a wrapped row)
- [ ] a lens click that would discard hand-tuned filters is recoverable, and near-miss states show which lens the view is a variation of

---

<a id="gpv-11"></a>

## GPV-11 · No view state reaches the URL — a lens, a focus, a search or an answer cannot be shared, bookmarked, or restored, and "Back to graph" claims a restoration it does not perform

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/graph/page.tsx:65-95`, `app/(protected)/graph/page.tsx:226-237`, `app/(protected)/graph/page.tsx:428-437`, `components/graph/BackToGraphChip.tsx:3-9`, `components/graph/BackToGraphChip.tsx:23`, `lib/graphSettings.ts:103-122`

**Mechanism.** Everything that describes what you are looking at lives in component state or localStorage, never in the URL. `focusId`, `selected`, `rawQuery`, `answer`, `pathEnds`, `pathMode`, `connect` are all `React.useState` in GraphPageInner. `hiddenTypes`/`showLibraryEdges` (the lens) and `localDepth` are persisted to `localStorage` per org — per browser, not per link. The one URL param, `?focus=`, does NOT engage focus mode: the effect at 227-237 only calls `setSelected(node)` and `setHighlight(...)`. So the parameter named `focus` and the feature named Focus are different things. `LENSES` is a plain const rebuilt inside the render body each frame (line 428) with no persistence of its own and no create/edit/save UI — a repo-wide grep for `LENSES|savedLens|customLens` finds it in exactly one file. BackToGraphChip's header promises "one tap returns to /graph, where the per-org saved layout and settings restore the exact map you left", but line 23 is `router.push("/graph")` with no query: the forces and hidden types come back, the node you had selected, the neighbourhood you had focused, the question you had asked, and the answer panel do not.

**Failure scenario.** A reliability engineer focuses on E-2201's two-hop neighbourhood, asks a question that lights up six nodes, and pastes the URL into a shift-handover ticket. The recipient opens it and sees the whole org map with their own saved settings and no highlight. The same engineer clicks a P&ID from the peek, reads it, taps "Back to graph" — and lands on the whole map with the focus gone and the answer panel closed.

**Evidence.**

```
app/(protected)/graph/page.tsx:74 `const [focusId, setFocusId] = React.useState<string | null>(null);` — a repo-wide grep for `focusId` finds it referenced only inside this file (plus an unrelated explorer-selection module). app/(protected)/graph/page.tsx:231-236 — `const id = focusParam.includes(":") ? focusParam : \`doc:${focusParam}\`; … setSelected(node); setHighlight(...)` — no setFocusId. components/graph/BackToGraphChip.tsx:23 `onClick={() => router.push("/graph")}`.
```

**Done when.**

- [ ] lens, focus id, depth, scope and search live in the query string and are read on mount, so a URL reproduces the view
- [ ] ?focus= either engages focus mode or is renamed to match what it does (?select=)
- [ ] BackToGraphChip preserves the graph's query string (stamped alongside from=graph on open) instead of pushing a bare /graph, or its comment is corrected
- [ ] users can name and save a lens (a stored hiddenTypes+scope+depth tuple) rather than being limited to four hardcoded presets

---

<a id="gpv-12"></a>

## GPV-12 · The Ask panel counts nodes it cannot show and the route's promised "answered" mode does not exist

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/graph/ask/route.ts:14-19`, `app/api/graph/ask/route.ts:49-59`, `app/api/graph/ask/route.ts:174-181`, `app/(protected)/graph/page.tsx:51-57`, `app/(protected)/graph/page.tsx:761-765`, `components/graph/OrgGraph2D.tsx:63-66`

**Mechanism.** Two separate honesty gaps. First, the route's header declares "Two answer modes, and it is always honest about which one you got: EVIDENCE … ANSWERED — the same evidence, plus a written answer grounded in it, when the org has a key configured", and `GraphAskResponse` types `mode: "evidence" | "answered"` and `answer: string | null`. The only construction of the payload sets `mode: "evidence", answer: null` — a grep for `answered` in the file returns exactly one hit, the type union. The client's `GraphAsk` interface does not even declare `mode` or `answer`, so the ANSWERED path is dead on both ends while the UI's affordances ("Find E-22, or ask a question…", "Ask ⏎", "Search what your documents say") promise a question box. Second, the returned `nodeIds` are computed server-side against the whole org graph, while the client lights them up against the CURRENT VIEW. The header reports `${answer.nodeIds.length} node(s) lit up` unconditionally; the renderers can only highlight ids the simulation holds, and the simulation is fed `view.nodes` (page.tsx:192-201). Nodes hidden by the active lens have no sim entry, so `flyTo` filters them out (`pts.length === 0` → early return) and the gold ring paints on nothing.

**Failure scenario.** On the Documents lens (which hides `asset`), a user asks "what governs pipe supports". The route returns eight asset nodeIds and three doc nodeIds. The panel says "11 nodes lit up". The camera does not move to the equipment, none of it glows, and there is no hint that eight of the eleven are filtered out of the current lens.

**Evidence.**

```
app/api/graph/ask/route.ts:174-176 — `const payload: GraphAskResponse = { mode: "evidence", question, answer: null, …` — the only payload construction; `grep -n '"answered"|answered'` on the file returns only line 50, the type. app/(protected)/graph/page.tsx:51-57 — `interface GraphAsk { question; hits; nodeIds; assets; note? }` with no mode or answer. app/(protected)/graph/page.tsx:763 — `` `${answer.hits.length} passage… · ${answer.nodeIds.length} node… lit up` ``. components/graph/OrgGraph2D.tsx:65-66 — `const pts = flyTo.ids.map((id) => sim.get(id)).filter(Boolean) …; if (pts.length === 0) return;`.
```

**Done when.**

- [ ] the count reported reflects nodes actually present in the current view, and hidden matches are called out with a one-click way to unhide them ("6 more in Equipment — show")
- [ ] the ANSWERED mode is either implemented and consumed by the client, or the mode/answer fields and the header comment are removed so the surface stops claiming a written answer it never produces

---

<a id="gpv-13"></a>

## GPV-13 · The map itself is unreachable by keyboard and invisible to assistive tech, and no key dismisses any of the four overlay modes

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/graph/OrgGraph2D.tsx:426-439`, `components/graph/OrgGraph3D.tsx:747-755`, `app/(protected)/graph/page.tsx:453`, `app/(protected)/graph/page.tsx:686-728`, `app/(protected)/graph/page.tsx:822-854`

**Mechanism.** The 2D `<canvas>` is rendered with `className`, `style`, and five pointer/dblclick handlers — no `tabIndex`, no `role`, no `aria-label`, no text alternative, no keydown handler. The 3D renderer's `domElement` is appended to a bare div and wired with pointerdown/move/up/cancel/leave, wheel, dblclick and contextmenu — again no key events. Two differently-shaped searches confirm the scope: `grep "onKeyDown|keydown|tabIndex|role=|aria-|addEventListener(\"key"` across the graph page and components/graph/ returns exactly one keyboard handler (the search input's Enter at page.tsx:453) plus five `aria-label`s on close buttons; a case-insensitive grep for "keyboard|arrowkey|accessib" over the same paths returns nothing. There is no global key handling at all, so Escape does not exit Path mode, Connect mode, Focus, or close the answer panel — each has only a mouse target. Path mode and Connect mode are also entered exclusively by clicking nodes on the canvas, so a keyboard-only user cannot reach them by any route.

**Failure scenario.** A keyboard-only or screen-reader user tabs onto /graph. Focus moves through the search box, the lens buttons, the Insights button and the Settings drawer, and skips the canvas entirely — the primary content of the page is announced as nothing. They can list orphans and hubs in the Insights panel (those are real buttons), but clicking one only moves a camera they cannot see and opens a peek whose "Go in"/Connect actions then require clicking a node on the canvas. A sighted mouse user who starts Connect by mistake must find the small X in the panel; pressing Escape does nothing.

**Evidence.**

```
components/graph/OrgGraph2D.tsx:428-437 — the canvas element carries `ref`, `className`, `style`, `onPointerDown`, `onPointerMove`, `onPointerUp`, `onPointerCancel`, `onDoubleClick` and nothing else. components/graph/OrgGraph3D.tsx:436-443 — eight `el.addEventListener` calls, none for a key event. app/(protected)/graph/page.tsx:453 — `onKeyDown={(e) => { if (e.key === "Enter") void runAsk(); }}` is the only keyboard handler on the page.
```

**Done when.**

- [ ] the canvas is focusable and labelled, with arrow-key/Tab traversal of nodes and Enter to select — or an equivalent accessible list view of the same graph
- [ ] Escape exits Connect, Path and Focus and closes the answer and peek panels
- [ ] Path and Connect can be entered without a canvas click

---

<a id="gpv-14"></a>

## GPV-14 · The unit's pinned libraries and its bound AI knowledge library are real org-authored relationships that the graph never draws

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:104`, `lib/orgGraph.ts:198-203`, `lib/codebook.ts:29-56`, `lib/codebook.ts:368-380`, `app/(protected)/admin/assets/page.tsx:232`, `app/api/area/knowledge-status/route.ts:54`

**Mechanism.** `codebook_entries.meta` on a unit entry carries `links: UnitResourceLink[]` ("a library, or one folder of it, pinned to an operating unit — 'the crude unit's P&IDs live here'") and `knowledgeLibraryId` ("the AI knowledge library bound to this operating area"). buildOrgGraph does call `loadCodebook(orgId)` but reads only `u.code` and `u.label` from each unit entry. Two differently-shaped greps confirm the omission: `grep -n "meta|links|knowledgeLibrary" lib/orgGraph.ts` returns only the four unrelated `truncations.push("… links capped")` lines; and a repo-wide `grep "meta\.links|meta?\.links|knowledgeLibraryId"` lists the readers — app/(protected)/admin/assets/page.tsx, components/assets/AreaKnowledgePanel.tsx, app/api/area/knowledge-status/route.ts, lib/flowsBrowse.ts — with lib/orgGraph.ts absent from the list. So the single most deliberate structural statement an org makes about a unit ("these folders ARE this unit's documents") produces zero edges.

**Failure scenario.** An admin spends an afternoon on /admin/assets wiring Unit 20 to the P&ID folder, the operating-manual library and its knowledge shelf. They then open /graph expecting the crude unit to pull its paper toward it. Nothing changed — the cbunit node still connects only to equipment. The graph's own marketing line (components/marketing/TourTabs.tsx:31, "Documents, equipment, and operating areas as one living map") overstates what was assembled.

**Evidence.**

```
lib/codebook.ts:29-36 — `export interface UnitResourceLink { id; label; libraryId; libraryName; folderId?; folderName? }` with the comment "A library (or one folder of it) pinned to an operating unit". lib/codebook.ts:50-53 — `knowledgeLibraryId?: string;` "the AI knowledge library bound to this operating area". lib/orgGraph.ts:198-203 consumes only `u.code` and `u.label`.
```

**Done when.**

- [ ] each unit's meta.links produces a cbunit→library edge (and, where folderId is set, a scoped edge or a folder node)
- [ ] meta.knowledgeLibraryId produces a cbunit→library edge with its own edge type so a viewer can tell a pinned shelf from a filing library
- [ ] those edges are the primary structure a unit scope pivot filters on, so scoping to Unit 20 pulls in its pinned paper directly rather than via equipment

---
