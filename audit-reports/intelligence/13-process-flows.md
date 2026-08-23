# 13 · Process flows & the PFD reader

**14 findings** — 4 HIGH · 10 MEDIUM.

**Your PFD question.** Grounding, lifecycle, and what topology could power.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The grounding contract is genuinely enforced on the RESPONSE, not merely asserted in the prompt | `app/api/flows/read/route.ts:67-71, 144-166` | The roster is built server-side into an opaque handle map (`const byRef = new Map(roster.map((r) => [r.ref, r]));`, line 70) and every returned edge is resolved through it: `const from = f.from ? byRef.get(f.from) : undefined; … if (!from \|\| !to \|\| from.ref === to.ref) continue;` (lines 146-148). A hallucinated tag string cannot become a row because the model never sees or emits tag strings — only A1/U2 handles. The stored `from_ref` is the registry UUID or codebook code the SERVER chose, never text the model produced. This is the correct shape and should be the template for every other AI writer in the app; none of my findings weaken it. |
| lib/flowsBrowse.ts is pure, dependency-free assembly with a real test suite | `lib/flowsBrowse.ts:157-283, lib/__tests__/flowsBrowse.test.ts` | The API route feeds it plain data and does all I/O itself (route header comment, browse/route.ts:12). Seven tests pin the tree-nesting, subtree-coverage, empty-folder-folding, and orphan-mirror behaviours. Any fix to the state machine (e.g. adding `ingest_failed`) is a small, testable change in one pure function rather than a UI edit. |
| The browse route enforces document-control ACLs as law, not as a picker convenience | `app/api/flows/browse/route.ts:93-105, 155-166` | Folders the caller cannot read are dropped by name before assembly (`if (!containerReadable("folder", id, principal, landscape)) continue;`), per-document readability is re-checked via `readableControlledDocIds`, and — the subtle part — mirrors of unreadable docs are also filtered (line 165-166) so a hidden document's name cannot resurface under 'Uploaded directly'. This closes the leak that the same feature would otherwise open, and the comment at 89-92 shows it was reasoned about deliberately. |
| Every document-control document appears in the picker with a named reason and a one-click fix, and the pagination is honest about it | `app/api/flows/browse/route.ts:113-153, components/assets/UnitOpsPanels.tsx:426-492` | Documents are paged with `.order("id")` and an explicit comment about why ("a flat cap returns an ARBITRARY slice past its limit", line 120-122) — the exact discipline missing from the reader's own 4000-row settled fetch and from `pageRows`. Blocked rows carry actionable hints and inline Sync / Link-to-AI buttons instead of dead-ending. Fixing the `error` state slots straight into this machinery. |
| lib/pidTrace.ts — a complete, pure, 15-test reachability engine that already preserves per-step direction | `lib/pidTrace.ts:105-216, lib/__tests__/pidTrace.test.ts` | `tracePath` returns ordered steps with `from`/`to` correct even when traversed backwards (lines 165-166), separates 'hop limit reached' from 'not connected' (lines 150-152), and `traceNeighbourhood` is literally the 'extreme pivot' primitive the owner is asking for. It needs no changes — only an adapter feeding it confirmed process_flows instead of page co-occurrence. |
| The orchestrator's trace tool states its own epistemic basis rather than overclaiming | `lib/orchestrator/tools.ts:301-306, 313-317` | `basis` says in plain words that the result is drawing-page co-occurrence, not valve-by-valve tracing, and a code comment records that an automated line-follower was tried against real SHX drawings and retired deliberately. This honesty is what makes the missing process_flows wiring a fixable gap rather than a silent lie, and the `basis` field is the natural place to distinguish confirmed-flow edges from inferred ones. |
| createManualFlow treats a duplicate pair as a no-op, and the migration's endpoint model is well-reasoned | `lib/processFlows.ts:50-70, supabase/migrations/20261017_process_flows.sql:9-12, 36` | The 23505 tolerance at line 69 is exactly right and is the pattern the read route should copy. The (kind, ref) endpoint design is documented with its rationale — asset UUIDs and codebook unit CODES are different identity spaces and the unit code is 'the identity the org actually navigates by'. The UNIQUE ordered-pair index is the right constraint; the bugs above are in the code around it, not in the schema's core shape. |
| Every flow-touching read degrades cleanly on a pre-migration org instead of breaking the page | `lib/processFlows.ts:32-34, 43-46; lib/orgGraph.ts:84-88, 131-134; components/assets/UnitOpsPanels.tsx:187-190` | `missing()` detects 42P01 and `listProcessFlows` returns `null`, which FlowPanel renders as a specific, actionable message ('run the process-flows migration to map what feeds what') rather than an error or an empty state. `pageRows` does the same for the graph. This is the right pattern for a feature shipped behind a migration and should be preserved by any fix. |


---


<a id="flow-1"></a>

## FLOW-1 · AI flow proposals for equipment with no operating-area code can never be reviewed — the only decision surface renders inside a selected Site Codebook unit

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/assets/page.tsx:580-583`, `components/assets/UnitOpsPanels.tsx:119-143`, `components/assets/UnitOpsPanels.tsx:150-154`, `app/api/flows/read/route.ts:57-71`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the only accept/dismiss surface in the codebase lives inside FlowPanel, FlowPanel only renders for a selected real unit, and a proposal whose endpoints both have unit_code = null matches no unit's filter. AreaKnowledgePanel.tsx:106-114 also touches flows but only counts `f.status === "confirmed"` — read-only, no decision. assets.unit_code is a plain nullable TEXT column (20260928_site_codebook.sql:78), so the CSV-import-before-categorize path really does leave proposals unreachable.

**Mechanism.** The reader's roster is ORG-WIDE — every non-archived asset (route:58) plus every codebook unit — so a proposal can land between any two assets in the registry. The only place `decideFlow` is called is FlowPanel (UnitOpsPanels.tsx:152), and FlowPanel is mounted behind `{unitFilter && unitFilter !== "__unassigned" && uid && (<FlowPanel ... unitCode={unitFilter} unitAssets={filtered} />)}` (assets/page.tsx:580-583). Inside, `refresh()` keeps only flows touching that unit (UnitOpsPanels.tsx:124-128). Two consequences: (a) `__unassigned` is explicitly excluded, so a proposal whose endpoints are both assets with a null `unit_code` has no review surface at all; (b) `unitAssets={filtered}` is the SEARCH-filtered list (assets/page.tsx:136-159 — `filtered` applies `search`, `typeFilter`, and `filterMode`), so typing in the search box or switching the photo filter silently shrinks the set of flows the panel considers relevant.

**Failure scenario.** An org imports a master equipment list via AssetCsvImportModal before running Auto-categorize, so 800 assets have `unit_code = null`. A DocCtrl reads the plant PFD; the model correctly proposes 15 flows among those 800 tags. Every one lands as `status='proposed'`. There is no operating-area card to open that contains them, `__unassigned` is hard-excluded from FlowPanel, and the graph only renders `status === "confirmed"` (lib/orgGraph.ts:287). The 15 flows are written, charged for, and permanently invisible. The reader's own success toast — "N flows proposed … review them above" (UnitOpsPanels.tsx:394-395) — points at a list that does not contain them.

**Evidence.**

```
app/(protected)/admin/assets/page.tsx:580 `{unitFilter && unitFilter !== "__unassigned" && uid && (`; UnitOpsPanels.tsx:124-128 filters `all` down to `mine.has(f.from_ref) || … || f.from_ref === unitCode || …`; lib/orgGraph.ts:287 `if (f.status !== "confirmed") continue;`
```

**Chain reaction.** This is the exact scenario in the owner's question 6 — a master list populates assets, the codebook categorises them later. Anything read off a drawing BEFORE categorisation runs is orphaned, and there is no counter, no badge, and no org-wide queue that would ever reveal it.

> **Verifier correction.** Both sub-claims stand as written. One refinement: for CONFIRMED flows on unassigned assets the graph does draw the edge (orgGraph.ts:286-289), so the dead end is specific to `proposed` rows — which is precisely the status the reader writes (route.ts:158).

**Done when.**

- [ ] An org-wide 'proposed flows' review surface exists (Intelligence hub or the graph), independent of unit selection
- [ ] FlowPanel is given the unit's full asset set, not the search-filtered `filtered` array
- [ ] The read response reports how many proposals landed outside the caller's current unit, and links to where they can be decided

---

<a id="flow-2"></a>

## FLOW-2 · Any active member can write a confirmed flow straight into the org's shared process map — the RLS INSERT policy has no controller gate and no status gate

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261017_process_flows.sql:49-54`, `lib/processFlows.ts:52-70`, `app/(protected)/graph/page.tsx:334-346`
- **Also surfaced independently as** [`AREA-3`](./12-operating-areas.md#area-3) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The insert policy is exactly as described, and there is no compensating UI gate: graph/page.tsx contains no role check whatsoever (grep for role/isController/canEdit returns only an unrelated /admin/proposed-links link at :745), and NodePeek.tsx:177 renders the Connect button purely on `onConnect &&`, which page.tsx:871 supplies for any doc:/asset:/cbunit:/unit: node. A Viewer's row is therefore written straight to the shared map at status='confirmed'.

**Mechanism.** `CREATE POLICY process_flows_insert ON process_flows FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = process_flows.org_id AND m.uid = auth.uid() AND m.status = 'active') AND created_by = auth.uid());` — the only conditions are active membership and self-attribution. It does not require `is_org_controller`, and it does not constrain `status`, `origin`, `source_document_id`, or `evidence`. The client-side writer `createManualFlow` (lib/processFlows.ts:59-68) hardcodes `status: "confirmed", origin: "manual"`, and it is reached from the graph's Connect mode (graph/page.tsx:335-343). Nothing on the graph page gates Connect on a controller role, and nothing stops a hand-rolled supabase call from inserting `status:'confirmed', origin:'ai'` with a forged `evidence.docName`.

**Failure scenario.** A contractor with a read-only Viewer seat opens /graph, enters Connect mode, and draws E-101 → T-201. The row lands as `status='confirmed', origin='manual'` and is immediately rendered as plant topology for every member (SELECT is org-wide, migration:44-47) — with no review step, because 'confirmed on arrival' is reserved for 'a human said so' and the policy does not ask WHICH human. On a PSM-regulated site this is an unreviewed change to the recorded process configuration made by someone with no authority over it.

**Evidence.**

```
migration:50-54, the full WITH CHECK — compare the UPDATE policy two lines below at 57-59, which DOES require `is_org_controller(org_id) OR created_by = auth.uid()`. Insert is strictly weaker than update on the same table.
```

**Chain reaction.** The asymmetry is worse than it looks: a Viewer can INSERT a confirmed flow and, because `created_by = auth.uid()`, can also UPDATE and DELETE it. So the least-privileged member has full lifecycle control over rows in the org's shared topology, while a Supervisor cannot touch a proposal the reader created.

**Done when.**

- [ ] INSERT requires `is_org_controller(org_id)`, or a status gate: non-controllers may only insert `status='proposed'`
- [ ] A CHECK or policy prevents a client insert from claiming `origin='ai'` or setting `source_document_id`/`evidence`
- [ ] The graph's Connect-mode flow branch is gated on the same capability server-side, not just visually

---

<a id="flow-3"></a>

## FLOW-3 · Manager and Supervisor see every flow control and none of them work: the button 403s, and Confirm/Dismiss/Delete fail silently against RLS

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/assets/page.tsx:56`, `app/(protected)/admin/assets/page.tsx:69`, `components/assets/UnitOpsPanels.tsx:179-184`, `components/assets/UnitOpsPanels.tsx:150-159`, `app/api/flows/read/route.ts:42-48`, `supabase/migrations/20261017_process_flows.sql:56-64`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly right — Manager/Supervisor get controls the server rejects, and the Confirm/Dismiss path fails with no error at all. Two things pull the severity down to MEDIUM: it fails CLOSED (no unauthorized write occurs), and 'none of them work' is overstated — the `created_by = auth.uid()` arm means a Manager can still delete or edit a flow they drew themselves on the graph; only rows created by someone else (i.e. the AI proposals) silently no-op. This is a broken-authority/UX defect, not a security or data-loss one.

**Mechanism.** Three authorities disagree about who may shape the process map. (1) The page: `const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];` (assets/page.tsx:56) → `isAdmin` (line 69) → passed to FlowPanel, which uses it to render the "Read flows from a document" button (UnitOpsPanels.tsx:179) and the accept/dismiss/delete buttons (lines 209-220, 237-242). (2) The route: `if (!m || m.status !== "active" || !["Admin", "DocCtrl"].includes(m.role ?? "")) return bad("Only admins and document controllers shape the process map.", 403);` (route:46-48) — and it selects only `role, status` (route:43), never `roles[]`. (3) RLS: UPDATE and DELETE are `USING (is_org_controller(org_id) OR created_by = auth.uid())` (migration:57-64), and `is_org_controller` (supabase/migrations/20260814_documents_delete_controllers.sql:31-40) checks `role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']`. `decideFlow` (lib/processFlows.ts:74-84) and `deleteFlow` (lines 86-89) go client-side through RLS and check only `error`; a PostgREST UPDATE/DELETE whose USING clause matches zero rows returns no error, so the promise resolves, `refresh()` runs, and the row is unchanged.

**Failure scenario.** A Supervisor opens the crude unit hub. She sees "Read flows from a document", clicks it, browses the whole document tree (the browse route admits any active member — browse/route.ts:45-46), picks the PFD, presses Read, and gets "Only admins and document controllers shape the process map." She then tries to accept a pending proposal instead: the check button spins, `decideFlow` returns cleanly because RLS filtered the row out (she is not a controller, and `created_by` is the Admin who ran the read), `refresh()` re-renders — and the proposal is still sitting there, amber, with no error anywhere. She concludes the feature is broken.

**Evidence.**

```
assets/page.tsx:56 `const ADMIN_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];` vs read/route.ts:46 `!["Admin", "DocCtrl"].includes(m.role ?? "")`. lib/processFlows.ts:77-83 — `const { error } = await supabase.from("process_flows").update({...}).eq("id", id); if (error) throw new Error(error.message);` — no rowcount check, no `.select()`.
```

**Chain reaction.** The route reading only `m.role` and not `roles[]` is a straight DEC-35 / DEC-1 violation in the other direction too: a user whose primary role is Manager but who holds DocCtrl in `roles[]` is REJECTED by /api/flows/read while being ACCEPTED by `is_org_controller` in RLS. The same person can delete a flow but not propose one. Hardcoded `["Admin","DocCtrl"]` string literals in a route are precisely what DEC-35 forbids ('No file under app/, lib/, or components/ may branch on a facility-specific role name').

> **Verifier correction.** Add a fourth disagreement the finding only gestures at: because route.ts:43 selects `role` alone and never `roles[]`, a member whose PRIMARY role is Manager but who holds DocCtrl as a SECONDARY role is 403'd by the route while RLS (which unions role and roles[]) would happily let them write. The route is stricter than the database in one direction and the UI is looser than both in the other.

**Done when.**

- [ ] The route resolves authority through the capability policy layer, honouring the additive `roles[]` union, not a hardcoded role-name array
- [ ] `decideFlow` / `deleteFlow` use `.select()` and treat a zero-row result as a permission error the user sees
- [ ] FlowPanel's `isAdmin` is derived from the same capability the server enforces, so no control renders that cannot act

---

<a id="flow-4"></a>

## FLOW-4 · The grounding roster is silently truncated to an arbitrary 300 assets — on a real plant the model is told most of the equipment does not exist

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:57-71`, `app/api/flows/read/route.ts:92-104`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: an arbitrary, unordered 300 of up to 4000 assets, with nothing tying the roster to the unit or document being read and no warning anywhere in the response (:174-181 returns only proposed/skippedSettled/pagesRead). The failure is doubly silent — the model is simply told the rest of the plant does not exist, and the 'no new flows found' note at :179 misattributes the result to the drawing.

**Mechanism.** The route loads up to 4000 assets — `supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false).limit(4000)` (route:58), with NO `.order()` — then builds the roster from `assets.slice(0, 300)` (route:68). Two independent problems compound: the 4000-row fetch is unordered so its contents are unspecified, and the 300-item slice discards 92.5% of a full fetch with no ordering, no relevance ranking (e.g. by the unit the drawing decodes to), and no report. The prompt then presents that slice as absolute truth: "ROSTER (the only entities you may connect)" (route:128) and "Use ONLY the roster handles (A1, U2, …)" (route:96-97). The response filter `byRef.get(f.from)` (route:146-148) enforces it correctly — which means a correctly-read flow between two real registry assets outside the 300 is silently discarded as ungrounded.

**Failure scenario.** A refinery with 3,200 registered tags reads its crude unit PFD. The roster contains an arbitrary 300 of those tags, almost certainly not the crude unit's. The model reads T-401 and P-402 off the sheet, cannot find handles for them, and either returns nothing or returns handles for whatever it can match. The user sees "No new flows found — the drawing may not print flow arrows between known tags" for a drawing whose tags are all in the registry.

**Evidence.**

```
route.ts:68 verbatim: `assets.slice(0, 300).forEach((a, i) => roster.push({ ref: `A${i + 1}`, kind: "asset", id: a.id, label: a.tag }));` — and route.ts:58 has `.limit(4000)` with no `.order()` above it. Note route:63-64 handles the zero-asset case with a careful, well-worded 412; the 300-of-3200 case gets nothing.
```

**Chain reaction.** This is the direct answer to owner question 4 ('can a PFD be read well enough to link flow from equipment to equipment?'). The grounding contract is honestly enforced on the response — that part is genuinely good — but it is enforced against a roster that does not contain the plant. The feature will appear to work in a demo org of 40 assets and appear broken at the scale it was built for, and the failure looks like an AI-quality problem rather than a slice.

**Done when.**

- [ ] The roster is scoped by relevance — decode the drawing number through the Site Codebook to its unit (the Bridge already does this in lib/equipmentBridgeServer.ts) and prioritise that unit's assets
- [ ] When the roster is truncated, the response says so and names the count omitted
- [ ] The asset query is ordered so the same document read twice grounds on the same roster

---

<a id="flow-5"></a>

## FLOW-5 · A dismissed flow can be re-proposed: the 'settled' guard reads an arbitrary 4000-row slice with no ORDER BY, and the dismissal contract is stated in a comment the code cannot keep

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:81-88`, `app/api/flows/read/route.ts:9-10`, `lib/processFlows.ts:72-73`, `lib/processFlows.ts:36-48`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified. Note the failure is all-or-nothing: because it is a single multi-row insert with no upsert clause, one resurrected dismissed pair discards every other valid proposal from that read and the user is charged for the AI call regardless (usage is metered at :133, before the insert).

**Mechanism.** The route's header promises "pairs already decided (confirmed OR dismissed) are never re-proposed" (route:9-10) and lib/processFlows.ts:72-73 repeats it: "Dismissals stay as rows — the reader must never re-propose a pair a human already rejected." The enforcement is `supabaseAdmin.from("process_flows").select("from_kind, from_ref, to_kind, to_ref").eq("org_id", orgId).limit(4000)` — no `.order()`. Postgres returns an unspecified row order for an unordered LIMIT, so which 4000 rows form `settled` is arbitrary and can change between reads. Above 4000 rows the guard is a coin flip. Separately, the key is the ORDERED pair `${kind}:${id}>${kind}:${id}` (route:87, route:149), so dismissing A→B does nothing to stop B→A being proposed — a real hazard on a PFD where the reader misreads arrow direction, since the human's 'no' is silently re-asked in mirror image.

**Failure scenario.** A refinery with 4,500 mapped flows dismisses "Unit 20 → T-401" as a misread. The next quarter's PFD re-read draws a 4000-row slice that happens to exclude that dismissed row, re-proposes the identical pair, and the batch insert then dies on 23505 against the still-present dismissed row (see the CRITICAL above) — so the whole read is lost AND the human's decision was ignored. Below 4000 rows the pair simply comes back reversed and the reviewer has to dismiss it a second time.

**Evidence.**

```
route.ts:83-84 `.from("process_flows").select("from_kind, from_ref, to_kind, to_ref").eq("org_id", orgId).limit(4000);` — no ordering, no status filter needed but no pagination either. route.ts:149 `const key = `${from.kind}:${from.id}>${to.kind}:${to.id}`;` — direction-sensitive key against a direction-agnostic UNIQUE index? No: the index is also ordered, so both A→B and B→A can coexist as rows.
```

**Chain reaction.** A dismissal that does not stick converts the review queue from a decision log into a treadmill. Reviewers stop dismissing and start ignoring, and 'proposed' rows accumulate — which is invisible, because nothing counts org-wide proposals anywhere (the setup page at app/(protected)/setup/page.tsx:94 counts only `{ status: "confirmed" }`).

> **Verifier correction.** HIGH is overstated. Below 4000 flow rows the guard is complete and the stated contract holds exactly; the unordered-LIMIT half only bites on a mature org. The mirror-direction half is real at any size, but it is arguable design rather than a broken contract: B→A is a different assertion from A→B, and the schema deliberately treats them as distinct rows. What is genuinely wrong is that neither the header comment nor the UI acknowledges either limit. MEDIUM.

**Done when.**

- [ ] The settled lookup is paged or replaced by a DB-side `NOT EXISTS` filter, with a deterministic order
- [ ] A dismissal blocks the reversed pair too, or the UI explains why the reverse is a separate decision
- [ ] A test asserts that a dismissed pair survives a second read of the same document

---

<a id="flow-6"></a>

## FLOW-6 · A flow can reference a deleted asset forever: no FK, no cleanup, and the endpoint renders as a bare ellipsis

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261017_process_flows.sql:17-20`, `lib/assets.ts:216-219`, `app/(protected)/admin/assets/page.tsx:1402`, `components/assets/UnitOpsPanels.tsx:147-148`, `lib/orgGraph.ts:171`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg holds. The graph side is worse than 'a bare ellipsis': orgGraph.ts:171 `if (a === b || !nodes.has(a) || !nodes.has(b)) return;` makes addEdge silently drop the whole flow, so the same dead row shows as an unnamed chip in the unit hub and as nothing at all on the Process lens — with no path to notice or clean it up.

**Mechanism.** The migration chose text refs over FKs deliberately and documents why (migration:9-12: "Endpoints are (kind, ref) pairs rather than hard FKs because the two ends live in different registries"). `from_ref TEXT NOT NULL` / `to_ref TEXT NOT NULL` — no `REFERENCES assets(id)`, so no `ON DELETE CASCADE`. `deleteAsset` is a hard delete: `const { error } = await supabase.from("assets").delete().eq("id", id);` (assets.ts:217-218), called from the asset editor at assets/page.tsx:1402, and it removes nothing from process_flows. Every other asset-linked table DID take the FK — `document_assets`, `asset_photos`, `entity_mentions`, `asset_aliases` all declare `REFERENCES assets(id) ON DELETE CASCADE` (grep over supabase/migrations for `REFERENCES assets(id)` returns nine such tables). process_flows is the sole exception.

**Failure scenario.** An admin deletes a duplicated asset row that happened to be a confirmed flow endpoint. The flow row survives with a dead UUID. In the unit hub, `endpointLabel` resolves it through `tagById.get(ref) ?? "…"` (UnitOpsPanels.tsx:148) — the batch tag lookup at line 138 returns no row — so the chip reads "… → E-204" permanently, with no way to tell whether that is a slow load or a dead reference. On the graph the edge simply vanishes: `addEdge` bails on `!nodes.has(a)` (orgGraph.ts:171) with no note. Archiving has the same effect more quietly, since orgGraph filters `.eq("archived", false)` (orgGraph.ts:116) and the reader's roster does too (route:58).

**Evidence.**

```
migration:17-20 — `from_kind TEXT NOT NULL CHECK (...), from_ref TEXT NOT NULL, to_kind TEXT NOT NULL CHECK (...), to_ref TEXT NOT NULL` with no FK clause; assets.ts:217-218, the entire body of `deleteAsset`.
```

**Chain reaction.** Orphan rows still occupy the UNIQUE index and still count against the reader's `.limit(4000)` settled-set fetch, so they actively degrade the dismissal guard described above. They also survive export/restore (lib/exportTables.ts:35), so a restore carries the dangling references forward.

> **Verifier correction.** Two softenings. The graph mitigates its own half: lib/orgGraph.ts:174 `if (a === b || !nodes.has(a) || !nodes.has(b)) return;` drops the dangling edge silently, so the topology view is not corrupted — only FlowPanel shows the ellipsis. And the "nine such tables" count is loose: `grep -rn "REFERENCES assets(id)"` returns nine LINES across seven migration files, one of which is ON DELETE SET NULL and two of which are in CATCHUP_2026-05-28.sql. The substantive claim — every other asset-linked table took an FK, process_flows alone did not — holds.

**Done when.**

- [ ] Deleting or archiving an asset either removes or tombstones its flows, and tells the user how many
- [ ] `endpointLabel` distinguishes 'loading' from 'this equipment no longer exists' and offers to remove the flow
- [ ] The graph reports dropped flow edges in `truncations` rather than dropping them in silence

---

<a id="flow-7"></a>

## FLOW-7 · A permanently failed PDF ingest reports 'Indexing… the Read button appears when it finishes (usually under a minute)' forever, and hides the stored error

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/flowsBrowse.ts:183-185`, `components/assets/UnitOpsPanels.tsx:427`, `lib/knowledgeIngest.ts:582`, `lib/knowledge.ts:64`, `lib/__tests__/flowsBrowse.test.ts:121-138`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and worse than stated: lib/knowledgeIngest.ts:539 selects `.in("status", ["pending", "stale", "indexing"])`, so an 'error' doc is NEVER re-picked-up — the spinner really is forever. app/api/flows/browse/route.ts:60 selects only `id, name, library_id, page_count, status, source_document_id`, so the stored error message never even leaves the server.

**Mechanism.** `status` on a knowledge document is `"pending" | "indexing" | "ready" | "stale" | "error"` (lib/knowledge.ts:64), and `error` is terminal — the ingester writes `.update({ status: "error", error: message.slice(0, 500) })` (knowledgeIngest.ts:582) and stores the reason. The picker collapses every non-ready status into one bucket: `const state: DcDocState = mirror ? (mirror.status === "ready" ? "ready" : "indexing") : …` (flowsBrowse.ts:183-185). The UI then renders that bucket as `indexing: { label: "Indexing…", hint: "Mirrored and being indexed — the Read button appears when it finishes (usually under a minute). Reopen or Sync to refresh." }` (UnitOpsPanels.tsx:427). The existing test covers exactly `pending` and `stale` (flowsBrowse.test.ts:126-127) and never exercises `error`.

**Failure scenario.** A 60 MB scanned PFD book fails ingest (OOM in unpdf, or an R2 fetch timeout). `knowledge_documents.status='error'` with a real message in the `error` column. In the flows picker the row shows a cyan spinner and "usually under a minute", indefinitely. The user presses Sync, reopens the modal, waits, and comes back tomorrow to the same spinner. The one document state in this system that carries a machine-recorded, actionable reason is the only one the picker refuses to name.

**Evidence.**

```
flowsBrowse.ts:183-185 verbatim: `const state: DcDocState = mirror ? (mirror.status === "ready" ? "ready" : "indexing") : d.block ? d.block : …` — a binary on `=== "ready"`. The file's own header (lines 12-22) lists seven states each of which "is still THERE, with the reason and the fix printed on it"; `error` is absent from that list entirely.
```

**Chain reaction.** This is the single largest violation of the picker's stated contract, and it is self-inflicted: the route already fetches `status` from `knowledge_documents` (browse/route.ts:60) and could fetch `error` in the same select. The user's mental model becomes 'the AI reader is slow' rather than 'this file failed', which is the difference between waiting and fixing.

> **Verifier correction.** HIGH is overstated: this is a label-honesty defect, not a functional break. The Read button correctly stays hidden for a non-ready mirror, so nothing wrong is *done* — the user is simply told to wait forever instead of being shown the stored `error` string. Also, the header list at flowsBrowse.ts:15-21 omits `indexing` as well as `error`, so "seven states, error absent" is a slightly loose reading of that comment.

**Done when.**

- [ ] `DcDocState` gains an `ingest_failed` member; flowsBrowse maps `status === "error"` to it
- [ ] The browse route selects `knowledge_documents.error` and passes the message through to the row hint
- [ ] A test asserts a mirror with `status: "error"` never renders as `indexing`

---

<a id="flow-8"></a>

## FLOW-8 · A recycle loop loses one of its two legs: addEdge's dedupe key is order-insensitive, so A→B and B→A collapse to a single drawn edge

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:170-179`, `lib/orgGraph.ts:286-289`, `supabase/migrations/20261017_process_flows.sql:36`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is exactly as claimed — two rows, one drawn edge, and two under-counted degrees. Severity is too high: because the renderer draws flows as undirected lines with no arrowhead and no direction readout (see FLOW-10, OrgGraph2D.tsx:202), one line and two lines between the same pair are visually and semantically identical today, so the user-visible loss is a link count.

**Mechanism.** The table's UNIQUE index is on the ORDERED pair `(org_id, from_kind, from_ref, to_kind, to_ref)` (migration:36), so A→B and B→A are legitimately two distinct rows and both are confirmable. The graph builder then does `const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`; if (edgeSeen.has(key)) return;` (orgGraph.ts:174-176). For a pair of flow rows in opposite directions the key is identical, so whichever row `pageRows` happens to return second is silently dropped before it reaches `edges`.

**Failure scenario.** A reflux loop — T-401 → P-402 (bottoms) and P-402 → T-401 (reflux return) — is correctly read off the PFD and both legs confirmed. The graph draws one line. With arrows off (the default, see the finding above) the loss is invisible; with arrows hypothetically on, the surviving edge would assert a one-way flow that is factually wrong. Recycle and reflux are ubiquitous in refining, so this is not an edge case in a crude unit.

**Evidence.**

```
lib/orgGraph.ts:174 `const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;` — the ternary exists specifically to make the key symmetric, which is correct for `tag`/`mention`/`library` and wrong for `flow` and `supersession`.
```

**Chain reaction.** Any future reachability or impact feature built on `buildOrgGraph`'s edge list inherits a topology that has quietly lost its cycles — and cycles are where isolation and blinding questions get interesting.

> **Verifier correction.** Cited line is 175, not 174 (the quoted text itself is exact). Impact is confined to the graph drawing — the underlying rows survive, and FlowPanel (UnitOpsPanels.tsx:230-245) lists both legs as separate chips — so the loss is visual only. MEDIUM stands.

**Done when.**

- [ ] Directional edge types (`flow`, `supersession`) dedupe on the ordered key `a|b|type`, not the symmetric one
- [ ] A test builds a two-row recycle loop and asserts both edges survive

---

<a id="flow-9"></a>

## FLOW-9 · Flow edges are capped at 8000 in an unordered fetch and the cap is never announced; the unit panel loads only the oldest 4000 flows org-wide

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orgGraph.ts:132-134`, `lib/orgGraph.ts:164-167`, `lib/orgGraph.ts:75-94`, `lib/processFlows.ts:36-48`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide check: `grep -n truncations lib/orgGraph.ts` shows no push for `flows.capped`, so the flow cap is genuinely silent. FlowPanel (UnitOpsPanels.tsx:121, 172-174) renders `${confirmed.length} confirmed` straight off that oldest-4000 slice with no cap warning.

**Mechanism.** `pageRows("process_flows", …, orgId, EDGE_CAP)` returns `{ rows, capped }` (orgGraph.ts:75-94) and the builder checks `capped` for `docAssets` (line 166), `projectDocs` (line 167), and `mentions` (line 306) — but never for `flows`, `related`, or `supersessions`. So `truncations` stays silent while flow edges are dropped. `pageRows` also issues `.range(from, …)` with no `.order()` (line 80-83), which makes the retained 8000 an unspecified subset rather than a defensible one. Separately, `listProcessFlows` — the source for both the unit hub FlowPanel and the area panel's flow count — is `.order("created_at", { ascending: true }).limit(4000)` (lib/processFlows.ts:41-42), i.e. the 4000 OLDEST flows org-wide, so on a mature plant the most recently confirmed and most recently proposed flows are the first to disappear from the review surface.

**Failure scenario.** A plant crosses 4,000 flows. A DocCtrl runs the PFD reader and the new proposals are written correctly — but `listProcessFlows` sorts ascending by `created_at` and truncates at 4000, so the brand-new proposals fall off the end of the fetch and never reach FlowPanel. The panel header still reads "N confirmed" from the stale slice. The user re-runs the reader, which now skips every pair as settled, and concludes nothing was found.

**Evidence.**

```
lib/processFlows.ts:41-42 `.order("created_at", { ascending: true }).limit(4000);` — ascending is exactly backwards for a review queue. lib/orgGraph.ts:164-167 shows four truncation pushes, none for `flows.capped`.
```

**Chain reaction.** Ascending-order truncation is the worst possible choice for a queue whose entire purpose is 'decide the newest thing the AI just proposed'. It also makes the CRITICAL batch-insert failure more likely, since new rows exist in the DB, are invisible in the UI, and still collide on the unique index.

**Done when.**

- [ ] `if (flows.capped) truncations.push(...)` is added alongside the existing three, and `related`/`supersessions` too
- [ ] `listProcessFlows` orders descending by created_at, or splits proposed/confirmed into separate bounded queries
- [ ] `pageRows` orders by a stable key so a cap yields a defensible subset

---

<a id="flow-10"></a>

## FLOW-10 · Flows are directional in the database and undirected on screen — the renderer excludes 'flow' from arrowheads, arrows default OFF, and a flow edge's alpha sits below the arrow threshold anyway

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/graph/OrgGraph2D.tsx:202`, `components/graph/OrgGraph2D.tsx:177-180`, `lib/graphSettings.ts:65`, `components/graph/GraphControls.tsx:213-215`, `app/(protected)/graph/page.tsx:430`, `lib/orgGraph.ts:34`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three barriers confirmed, and they compound: even with Arrows toggled on, a flow edge only clears alpha>0.3 when it is the hovered/selected edge (alpha 0.8), and it is still excluded by type. The unit hub's FlowPanel does print direction (UnitOpsPanels.tsx:212, ArrowRight between endpoints), but the Process lens the finding targets does not.

**Mechanism.** Every layer below the renderer preserves direction: the type comment is `| "flow"  // process flow: from FEEDS to (directional in meaning)` (orgGraph.ts:34), `addEdge` pushes `{a, b, type}` in from→to order, and the Process lens sells it as "the plant as flow" (graph/page.tsx:430). The 2D canvas then draws direction only here: `if (st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath))` (OrgGraph2D.tsx:202). `"flow"` is not in that list. Three independent barriers stack: (1) the type is excluded; (2) `showArrows: false` is the shipped default (graphSettings.ts:65) and its own tooltip says "Direction on supersession and curated links" (GraphControls.tsx:215) — flows are not even claimed; (3) a flow edge falls into the default alpha branch, `alpha = 0.2` (OrgGraph2D.tsx:177), which fails the `alpha > 0.3` gate even if the type were added. The 3D renderer has no arrow code at all — grep for `arrow` across components/graph/OrgGraph3D.tsx returns nothing.

**Failure scenario.** A process engineer opens the Process lens to answer "does the overhead go to the accumulator or does the accumulator feed the tower?" — the exact question the whole feature exists to answer. Both flows render as identical undirected cyan lines. There is no hover readout of direction on an edge and no legend beyond the colour name "Feeds (process flow)" (graphTheme.ts:42). The only place direction is legible is the FlowPanel chips in the unit hub (UnitOpsPanels.tsx:200, 234 — a lucide `ArrowRight`), which shows one unit at a time.

**Evidence.**

```
OrgGraph2D.tsx:202 verbatim: `if (st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath)) {` — with the section comment on line 201 reading "Direction, where direction means something." Flow is the one edge type where direction means everything.
```

**Chain reaction.** This hollows out the Process lens's stated purpose and, worse, makes AI misreads unfalsifiable at a glance: a reviewer confirming proposals in the unit hub has no way to sanity-check the whole confirmed topology for reversed arrows, because the map that would show them refuses to draw direction.

> **Verifier correction.** Two partial mitigations the finding half-notes: an edge on a found path gets `alpha = 1` (line 179) and `onPath` is its own clause in the :202 condition, so flow edges DO get arrowheads inside Path mode; and spotlighting a node raises in-spot alpha to 0.8 (line 178), though the type exclusion still blocks it there. Severity is a rendering/semantics defect with no data consequence — MEDIUM, not HIGH.

**Done when.**

- [ ] `"flow"` is added to the arrow type list and given an alpha above the arrow threshold (or the threshold is evaluated per type)
- [ ] Arrows default ON when the Process lens is active, and the Arrows tooltip names flows
- [ ] The 3D renderer either draws direction on flow edges or the Process lens says it cannot

---

<a id="flow-11"></a>

## FLOW-11 · MAX_PAGES=6 truncation is never reported, and the zero-result message blames the drawing for a book the reader only opened the first six pages of

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:27`, `app/api/flows/read/route.ts:73-79`, `app/api/flows/read/route.ts:174-181`, `components/assets/UnitOpsPanels.tsx:394-396`, `lib/knowledgePageRender.ts:30`, `lib/knowledgePageRender.ts:39-52`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The substantive defect stands: on the zero-result path the route returns `pagesRead` and the UI throws it away, so the user is told the drawing is at fault with no hint that only pages 1-6 were opened. But 'never reported' is overstated — UnitOpsPanels.tsx:567 places the cap in the picker itself (`placeholder="Pages (optional): 1-4 or 2,5,9 — up to 6 per read"`) and shows `reads p. …` for an explicit selection, so the cap is disclosed even though the failure message ignores it.

**Mechanism.** With no explicit `pages`, the route reads `Array.from({ length: Math.min(doc.page_count ?? 1, MAX_PAGES) }, (_, i) => i + 1)` (route:76-77) — pages 1..6 of however many the document has. `doc.page_count` was fetched (route:52) and is therefore known, but nothing compares it to `pages.length`. The response carries `pagesRead` (route:177) and a `note` (route:178-180), but the note is: "No new flows found — the drawing may not print flow arrows between known tags, or everything visible was already decided." The modal shows `pagesRead` ONLY on the success branch: `json.proposed > 0 ? `… from pages ${json.pagesRead.join(", ")} …` : (json.note ?? "No new flows found.")` (UnitOpsPanels.tsx:394-396). On the zero branch — the branch where the user most needs to know what was actually looked at — the pages read are dropped. `renderKnowledgePages` compounds it: it silently skips any page that fails to render (`} catch { /* skip this page */ }`, knowledgePageRender.ts:51) and any page outside `pdf.numPages` (line 40), so `images` can be a partial set with no signal.

**Failure scenario.** An engineer points the reader at a 40-page P&ID book whose PFD overview sheets are pages 31-33. The reader renders pages 1-6 (title sheet, legend, notes, symbol key), finds nothing to connect, and reports "No new flows found — the drawing may not print flow arrows between known tags." That sentence is a false statement about a document that does print flow arrows, on pages the reader never opened. The row in the picker did display "40 pages" (UnitOpsPanels.tsx:446), but nothing connects that number to the six that were read.

**Evidence.**

```
route.ts:27 `const MAX_PAGES = 6;`; route.ts:76-77 the `Math.min(doc.page_count ?? 1, MAX_PAGES)` slice; route.ts:179 the note text; UnitOpsPanels.tsx:396 `: (json.note ?? "No new flows found.")` — `pagesRead` unreferenced on this branch.
```

**Chain reaction.** Alongside this, `skippedSettled` (route:150, 175) is returned and never rendered anywhere in the modal, and proposals dropped for referencing a handle outside the roster are not even counted (route:148 `if (!from || !to || from.ref === to.ref) continue;` — a silent `continue`). So all three reasons a read can come back empty — truncated pages, already-decided pairs, and ungrounded model output — collapse into one message that names none of them.

> **Verifier correction.** "Never reported" is factually wrong and must be softened: the picker's page input placeholder at UnitOpsPanels.tsx:567 reads "Pages (optional): 1-4 or 2,5,9 — up to 6 per read", and every document row prints its page count at :446 (`${d.pageCount} page…`). So the 6-page cap IS disclosed and the user CAN steer it (parsePages, :363-376). What actually survives is narrower: on the zero-result branch the response's `pagesRead` is silently discarded, and the server never compares `doc.page_count` to `pages.length` to say "read 6 of 41". MEDIUM.

**Done when.**

- [ ] The response includes `pagesTotal` and a `truncated` flag; the modal prints "read pages 1-6 of 40" on BOTH branches
- [ ] `skippedSettled` and a new `skippedUngrounded` count are surfaced in the result message
- [ ] A partial render (fewer images than pages requested) is reported rather than absorbed

---

<a id="flow-12"></a>

## FLOW-12 · One duplicate pair destroys the entire read: proposals are inserted as an unguarded batch while createManualFlow explicitly tolerates 23505

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/flows/read/route.ts:169-173`, `app/api/flows/read/route.ts:82-88`, `lib/processFlows.ts:69`, `supabase/migrations/20261017_process_flows.sql:36`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the window is wider than the concurrency race described: the `settled` snapshot at route.ts:82-84 is `.select(...).eq("org_id", orgId).limit(4000)` with no ORDER BY, so on an org past ~4000 flow rows a single reader can miss an already-decided pair and abort its own whole batch after paying for the vision call.

**Mechanism.** The table carries `UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)` (migration:36). The reader pre-filters against a `settled` set built from one snapshot read (route:82-88), then writes every surviving proposal in a single statement: `const { error } = await supabaseAdmin.from("process_flows").insert(rows); if (error) return bad("Reading succeeded but writing proposals failed: " + error.message, 500);`. There is no `onConflict`, no `ignoreDuplicates`, no per-row loop. PostgREST executes a multi-row INSERT as one statement, so a single 23505 aborts all of it — up to 20 proposals are discarded. The sibling writer got this right and says so: lib/processFlows.ts:69 is `if (error && error.code !== "23505") throw new Error(error.message);` with the comment "The unique pair index makes a duplicate a no-op, not an error." The reader never adopted that rule.

**Failure scenario.** Two DocCtrls open the unit hub during a turnaround and both press Read on the same PFD book within the same minute. Both compute `settled` from the same pre-insert snapshot; both models return the overlapping pair A-101 → E-201. The first insert lands 14 proposals. The second insert hits 23505 on that one row and the user sees "Reading succeeded but writing proposals failed: duplicate key value violates unique constraint" — with zero rows written, a 90-second wait, and a metered AI charge already recorded against their own key at route:133 (`recordAskUsage(... ok: true ...)` runs BEFORE the insert). The same happens single-user whenever a manual Connect on the graph beat the reader to any one pair.

**Evidence.**

```
route.ts:170 `const { error } = await supabaseAdmin.from("process_flows").insert(rows);` — bare batch insert. Contrast lib/processFlows.ts:69 `if (error && error.code !== "23505") throw new Error(error.message);`
```

**Chain reaction.** Because spend is metered before the write, the failure mode is 'charged and got nothing'. Users learn not to re-run the reader, which is exactly the behaviour that keeps the flow topology empty — and an empty topology is why every downstream question in this audit ('extreme pivot', upstream/downstream impact) has no data to work with.

> **Verifier correction.** Severity is overstated at CRITICAL. The route is not unguarded: route.ts:150-151 pre-filters against `settled` AND does `settled.add(key)` inside the loop, so intra-batch duplicates cannot occur, and the key at :149 (`${from.kind}:${from.id}>${to.kind}:${to.id}`) is an exact mirror of the UNIQUE tuple. For any org under 4000 flow rows the prefilter is complete and no 23505 is reachable. The defect only fires on (a) orgs above the `.limit(4000)` snapshot at route.ts:84, or (b) two admins reading concurrently. Real robustness gap — a paid AI call whose whole output is discarded — but a narrow precondition, so MEDIUM, not CRITICAL.

**Done when.**

- [ ] The proposal write uses per-row upsert or `ignoreDuplicates` so a colliding pair is skipped and the rest land
- [ ] The response distinguishes `proposed`, `skippedSettled`, and `skippedDuplicate` counts
- [ ] `recordAskUsage` is not the last word on a run whose write failed — either the failure is reported alongside the charge, or the write happens before the meter

---

<a id="flow-13"></a>

## FLOW-13 · PFD pages are rendered at 1400px — the width tuned for standards tables, below the 1800px the ingester uses precisely so 'small tags stay legible'

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/knowledgePageRender.ts:19-20`, `lib/knowledgePageRender.ts:42-45`, `lib/knowledgeIngest.ts:161-163`, `app/api/flows/read/route.ts:78`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The factual contrast is exactly as stated — the flow reader reuses the deep-read width tuned for standards tables, while the ingester deliberately renders 1800px for tag legibility. Downgraded because this is a tuning constant with a plausible but unmeasured effect, not a defined failure: nothing shows the model actually misses tags at 1400px, and the reader's grounding roster (route.ts:67-71, 146-148) still blocks any tag it did not have on the roster.

**Mechanism.** The flows reader calls the shared deep-read renderer: `const images = await renderKnowledgePages(doc.file_key, pages, MAX_PAGES);` (route:78), which rasterises at `const RENDER_WIDTH = 1400; // readable table text, modest tokens` (knowledgePageRender.ts:20). That module's header states its purpose plainly: "The text layer loses what standards actually print: formulas typeset as figures, multi-column stress tables (B31.3 Table A-1), charts" — it was built and tuned for standards documents, not for engineering drawings. The vision ingester, which WAS built for drawings, uses `width: 1800, // small tags stay legible` (knowledgeIngest.ts:162). The flows reader inherits the lower of the two with no override parameter and no per-document-type branch. On an ANSI D sheet (34 in wide) with 1/8-in tag text, 1400px yields roughly 1400 x (0.125/34) ≈ 5 px of glyph height; on an E sheet (44 in) roughly 4 px.

**Failure scenario.** A full-size PFD is read at 1400px. Equipment tags are a few pixels tall, and the printed stream labels the prompt asks for ("label: the stream's name as printed", route:100) are smaller still. The model returns few or no flows, or returns handles for tags it guessed rather than read — and the prompt's own guard, "Connect an entity only when its tag or unit is PRINTED on the drawing" (route:97-98), cannot be verified by the server. The user sees "No new flows found" and blames the drawing.

**Evidence.**

```
knowledgePageRender.ts:20 `const RENDER_WIDTH = 1400;          // readable table text, modest tokens` versus knowledgeIngest.ts:162 `width: 1800,                                  // small tags stay legible`. The two comments state the two different design intents explicitly.
```

**Chain reaction.** Marked SUSPECTED because extraction quality cannot be observed from the repository — no provider, no fixture, and no test exercises the read route. That absence is itself the finding: there is no golden-PFD fixture anywhere, so a resolution regression here would be undetectable. Two differently-shaped searches (`grep -rln 'flows/read|flows/browse|processFlows' --include=*.test.ts` and `ls lib/__tests__ | grep -i flow`) confirm the only flows test is lib/__tests__/flowsBrowse.test.ts, which covers pure tree assembly and never touches the reader.

> **Verifier correction.** Keep SUSPECTED, and for a sharper reason than the finding gives: the ~4-5 px glyph-height arithmetic is an unverified estimate (no drawing was rendered, no model was run), and legibility at a given raster width depends on the source PDF's vector line weights and the provider's own image downscaling, none of which is observable from the repo. What is CONFIRMED is only the inconsistency — the drawing-reading path uses the standards-tuned width while the other drawing-reading path in the same codebase deliberately uses 1800.

**Done when.**

- [ ] `renderKnowledgePages` takes an explicit width and the flows reader passes at least the ingester's 1800, or tiles a large sheet into overlapping quadrants
- [ ] A fixture PFD with known tags exists and a test asserts the parser+grounding path yields the expected pairs from a canned model response
- [ ] The read response reports the render width/DPI used so a poor result can be diagnosed rather than guessed at

---

<a id="flow-14"></a>

## FLOW-14 · The confirmed flow topology feeds nothing but line-drawing — the app's reachability engine is fed by page co-occurrence instead, and every reasoning surface is blind to it

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/orchestrator/tools.ts:369-377`, `lib/orchestrator/tools.ts:287-312`, `lib/pidTrace.ts:105-216`, `lib/orgGraph.ts:286-289`, `app/(protected)/setup/page.tsx:94`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The absence claim holds — no reasoning surface reads process_flows. Severity lowered because the finding's harm story ('asserts a connection that may not exist') is directly guarded against: tools.ts:296-300 hard-codes a `basis` string returned with every result ('This is sheet-level connectivity, not valve-by-valve line tracing') and tools.ts:352-355 adds an explicit 'Do not invent the routing between them' instruction. This is an unrealised integration, not a wrong answer being asserted.

**Mechanism.** Three differently-shaped searches (bare `process_flows`, case-insensitive, and `from("process`) return exactly six consumers: lib/processFlows.ts (CRUD), the two /api/flows routes, lib/orgGraph.ts:134 (draw lines), app/(protected)/setup/page.tsx:94 (a `count("process_flows", { status: "confirmed" })` stat), and lib/exportTables.ts:35 / lib/dataRestore.ts:294 (backup manifests). Meanwhile lib/pidTrace.ts is a complete, pure, tested traversal engine — `tracePath` (shortest route with per-step direction preserved, lines 105-180) and `traceNeighbourhood` ("if I blind this exchanger, what am I touching?", lines 182-216), with 15 tests in lib/__tests__/pidTrace.test.ts. Its single caller is the orchestrator's `trace_pid_lines` tool, and that tool's edges come from `loadLineGraph`, which reads `knowledge_page_entities` — `.select("document_id, page, kind, tag").in("kind", TAG_ENTITY_KINDS)` (tools.ts:371-374) — and infers connectivity from tags appearing on the same page. The tool says so honestly (tools.ts:303-306: "Derived from equipment appearing together on the same drawing page … This is sheet-level connectivity, not valve-by-valve line tracing"). It never reads process_flows.

**Failure scenario.** An org confirms 200 directional flows off its PFD book — real, human-verified topology. A user then asks the assistant "what's between P-101 and E-204?" The orchestrator answers from page co-occurrence, which for two tags on the same crowded P&ID sheet asserts a connection that may not exist, and for two tags one sheet apart asserts none even though a confirmed flow row says otherwise. The 200 confirmed flows contribute nothing to the answer. The same holds for `lib/impact.ts` / `lib/revisionImpact.ts` (no process_flows reference) — a revision to the drawing governing an upstream vessel never fans out downstream by process.

**Evidence.**

```
tools.ts:370-376 verbatim start: `const { data, error } = await supabaseAdmin.from("knowledge_page_entities").select("document_id, page, kind, tag").eq("org_id", orgId).in("kind", TAG_ENTITY_KINDS as unknown as string[])` — the whole edge source. Searches run: `grep -rni process_flows` across ts/tsx/sql/md; `grep -rn 'from("process'`; `grep -rn pidTrace|tracePath|traceNeighbourhood`. All three agree.
```

**Chain reaction.** This is the answer to 'is flow topology used for anything beyond drawing lines' and it is also the answer to the owner's question 3 about an extreme pivot. `traceNeighbourhood(edges, startTag, hops)` IS the extreme-pivot primitive — 'crude unit: all of this goes here' is reachability from a unit node — and it already exists, tested, one import away. What is missing is a 40-line adapter that converts confirmed `process_flows` rows into `LineEdge[]` (resolving `from_kind='asset'` UUIDs to tags via the registry and `from_kind='unit'` codes to codebook units, setting `lineId` from the flow id, `drawingId` from `source_document_id`). With that adapter: the graph gets a real scope filter, the orchestrator gets exact upstream/downstream answers grounded in human-confirmed edges rather than page adjacency, and revision impact can fan out by process.

> **Verifier correction.** Three factual corrections. (1) Only ONE of the two /api/flows routes touches process_flows — app/api/flows/browse/route.ts does not. (2) loadLineGraph DOES carry `.order("document_id", { ascending: true }).limit(20000)` (tools.ts:375-376), so the quoted "whole edge source" snippet is truncated mid-chain. (3) traceNeighbourhood starts at :189, not :182. And the classification is wrong: this is an unrealized-capability observation (a directed-graph engine and a directed-edge table that were never joined), not a defect that produces a wrong answer — the tool already labels its own basis honestly. MEDIUM.

**Done when.**

- [ ] A `flowsToLineEdges(orgId)` adapter exists that maps confirmed process_flows into `LineEdge[]` with tag-normalised endpoints
- [ ] `loadLineGraph` merges confirmed flows with page co-occurrence and the `basis` string distinguishes the two sources per edge
- [ ] The graph gains a scope-to-reachable-set filter driven by `traceNeighbourhood`, so selecting a unit shows what it feeds and what feeds it

---
