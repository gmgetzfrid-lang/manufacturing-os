# PRD — One Estate: the facility as a single linked environment

> **Status:** living requirements, agreed in conversation on 2026-10-13/14.
> **Owner:** gmgetzfrid-lang. **Read this before touching search, the
> graph, equipment, projects, knowledge, or ingestion.** Nothing here is
> implemented until the phase table below says so.
>
> Companion: `docs/ARCHITECTURE.md` (what exists and where). This file is
> what it must become.

---

## 1. The problem, in the owner's words

- Every tab grew its own search. The Documents table searches metadata,
  Cmd+K fans out tsvector queries, Knowledge "Ask" reads OCR and
  embeddings, the Documents graph reads names and folders in the browser.
  None of them reads what the others know. There is no main brain.
- Equipment is in three places that don't talk: the equipment index
  (registry), equipment *files* (folders under a unit), and equipment
  *tags* read off P&IDs. Vision and OCR already find tags, but the result
  stays inside the knowledge library instead of populating the registry,
  the document, and the unit.
- Projects are not linked to a unit, a plant, or an asset. They reach the
  graph only through checked-out documents. A project with no checkouts is
  an island. The 3D Intelligence graph therefore "doesn't see projects".
- The Documents graph and the Intelligence graph are two graphs. A file in
  one is not the same node in the other.
- Users are the wild card. Any convention we define will be bastardised by
  laziness: folders named after people, scans named by the copier
  (`OC74321.pdf`), copies in five places, things filed under the wrong
  unit. The Thor drive (20 years of network-share dumping) is what that
  looks like at scale, and the controlled system will drift the same way
  without something actively resisting it.
- The owner needs to find things **like a person who has never seen the
  drive would**: by what they mean, not by the naming convention. And when
  they look, they must not be buried in noise.

## 2. Principles (non-negotiable)

1. **One identity, many locations.** A unit, an asset, a document, a
   project each exists once. Where it is filed is an edge, not a copy.
   "Symbolic links" are edges. Keep-and-link beats move.
2. **Every edge carries provenance.** Who or what asserted it (human,
   codebook, bridge, proposer, vision), the evidence (the sentence, the
   page, the folder name, the drawing-number decode), and a confidence
   tier (`provable` / `strong` / `inferred`). An edge with no reason is a
   bug.
3. **Proposals, not writes.** Provable edges apply themselves and still
   show their evidence. Everything inferred waits for a human in Review.
   A machine never removes an edge a human made.
4. **Read bytes once.** OCR, vision, mentions, and embeddings attach to the
   version's **file hash**. A copy anywhere with the same bytes inherits
   them. No page is read twice.
5. **Cheap before expensive.** Names, folders, codes, tags, page entities,
   mentions, and full text are free. Semantic search runs only when the
   cheap layers are thin. A model reasons only in Ask. Plain search never
   calls a model.
6. **Privacy wall stays.** The AI boundary (`lib/aiBoundary.ts`) decides
   what may be read. What has not been read is reported as such ("3 files
   here have never been read"), never silently missing.
7. **Noise is a failure.** A result set is scoped, grouped by kind and
   relationship, ranked with reasons, and hides the irrelevant *with a
   count*, never silently. Clutter on a graph is the same failure.
8. **Explain, don't just rank.** Every result and every edge can answer
   "why is this here?" in one sentence.

## 3. Vocabulary

| Term | Meaning | Where it lives today |
|---|---|---|
| Plant / Unit / System | The facility hierarchy (Site Codebook unit codes: "20" = Crude) | `plants`, `units`, `systems`, `codebook_entries` |
| Asset | A tagged piece of equipment (X-35, U1-A); one row per normalized tag | `assets` (+ `asset_aliases`, `asset_types`) |
| Document / Version | A controlled record and its immutable file revisions; bytes in R2 | `documents`, `document_versions` (`file_hash`) |
| Folder / Library | Where a document is filed (a location, not an identity) | `collections`, `libraries` |
| Project | An AFE / job; today linked to documents only via checkout | `projects`, `project_documents` |
| Knowledge mirror | The AI-readable copy of a controlled document inside a linked source | `knowledge_documents` (`source_document_id`, `source_version_id`) |
| Chunk / Page entity / Mention | OCR or vision text per page; a tag seen on a page with x,y; a sentence naming an asset | `knowledge_chunks`, `knowledge_page_entities`, `entity_mentions` |
| Proposal | A discovered edge awaiting review, with evidence and tier | `proposed_links`, `document_equipment_suggestions` |
| Alias | What people *say* vs what files *say* ("born" = Crude; "north furnace" = F-101) | `asset_aliases`, `finder_aliases` |
| Drive listing | A pasted directory tree of a share the system does not hold (paths only) | `finder_listings` |
| Lens | One view of the single graph, rooted somewhere, filtered somehow | Documents graph, Intelligence graph, asset page, unit hub, project page |

## 4. What exists (do not rebuild)

| Capability | Module | Gap |
|---|---|---|
| Codebook decode (unit, equipment prefix, drawing number) | `lib/codebook.ts` | — |
| Drawing → equipment bridge: page entities → unit → site code → registry (creates discovered assets) → document tag column | `lib/equipmentBridgeServer.ts` | Runs only for files inside linked knowledge sources |
| Link proposer with tiers and Review tab | `lib/linkProposals.ts`, `/admin/proposed-links` | Document↔document only; no folder/unit/project edges |
| Asset categorisation from codebook | `lib/assetCategorize.ts` | — |
| Tag spelling resolver | `lib/knowledgeTagResolve.ts` | Used by Ask only |
| Mentions with sentence, page entities with position | `lib/mentionIndexer.ts`, `knowledge_page_entities` | Not consulted by any search but Ask |
| Hybrid retrieval, RRF fusion, embeddings | `lib/hybridRank.ts`, `lib/ai/embeddings.ts` | Knowledge chunks only |
| Org graph (units, assets, docs, projects, plants, libraries, plots) | `lib/orgGraph.ts`, `/graph` | No folder nodes; projects only via checkout; separate from Documents graph |
| Finder: plain-language parse (codes, words, phrases, sheet, rev, type, year, unit, aliases), tiered evidence ranking, balloon-tree map, drill-down, drive listings | `lib/fileFinder/*`, `/documents/graph` | Browser-side, names/folders/metadata only; does not read tags, entities, mentions, or text |
| AI boundary, cheap vision tier, per-version indexing | `lib/aiBoundary.ts`, `lib/knowledgeVision.ts` | — |

## 5. Requirements

### R1 — Identity and keys
- R1.1 `knowledge_documents` carries `file_hash`; facts (chunks, entities,
  mentions, embeddings) are reachable by hash as well as by version.
- R1.2 Any document version whose hash matches an indexed hash is treated
  as read. The finder's "same bytes in N places" and the knowledge index
  agree on identity.
- R1.3 Node ids are stable and shared by every lens: `plant:`, `unit:<code>`,
  `system:`, `asset:<id>`, `doc:<id>`, `folder:<id>`, `lib:<id>`,
  `proj:<id>`, `drive:<id>`, `extf:` / `ext:` for listings.

### R2 — The graph store and its lenses
- R2.1 One edge table (or one view over the existing ones) with: `a`, `b`,
  `type`, `origin` (human / codebook / bridge / proposer / vision /
  finder), `evidence` (JSON, human-readable summary required), `tier`,
  `created_by`, `created_at`, `version_id` when the fact belongs to a
  revision.
- R2.2 Edge types (minimum): `filed_under` (doc→folder, folder→folder,
  folder→library), `belongs_to_unit` (folder/doc/asset/project→unit),
  `drawn_on` (asset→doc page), `mentioned_in` (asset→doc page, sentence),
  `tagged_to` (doc→asset, a filing decision), `project_scope`
  (project→unit/asset/doc), `same_bytes` (doc↔doc), `alias_of`,
  `supersedes`, `related` (curated).
- R2.3 Folders are nodes. Every folder under a unit-named ancestor
  inherits `belongs_to_unit` (provable when the name decodes through the
  codebook or an alias).
- R2.4 Every lens (Documents graph, Intelligence 2D/3D graph, asset page,
  unit hub, project page) reads the same nodes and edges. Clicking an
  asset in the Documents graph is the same node the equipment hub shows.
- R2.5 Facts belong to the version they were read from. A lens prefers
  current-version edges and labels older ones.

### R3 — The resolver (ingestion pre/post engine)
- R3.1 One resolver over name + path + (when read) content, reusing the
  finder's parser: codes, words, phrases, sheet, rev, doc type, year, unit,
  aliases, plus codebook decode of drawing numbers and tags.
- R3.2 Runs on events: upload, folder create/rename/move, version publish,
  OCR/vision completion, listing paste, alias taught. Also on demand for
  backlogs (idempotent).
- R3.3 Emits proposals with tier and evidence. Provable applies (and is
  still visible and reversible); strong/inferred wait in Review.
- R3.4 Discovers assets: a tag read on a drawing that is not in the
  registry becomes a *discovered* asset with provenance (the bridge
  already does this; extend to every container, not only sources).
- R3.5 Proposes aliases (`origin = ingest`): a folder named "Born" under
  Crude with heater drawings inside → "born" may mean Crude. Review only.
- R3.6 **Convention watchdog.** At folder-create and upload time, the
  resolver states what it thinks the thing is and where its home is, and
  offers: file it there, or keep here **and link** there. Never blocks,
  never moves silently.
- R3.7 Projects: an AFE number in a folder or file name links the folder
  and its contents to the project; a unit named alongside links the project
  to the unit (strong → Review).

### R4 — The find service (the main brain's retrieval)
- R4.1 One server endpoint (`/api/find` or equivalent) every search box
  calls: Documents table, Cmd+K, Documents graph, equipment page, unit hub,
  project page, Knowledge, and the orchestrator's document tools.
- R4.2 Layers, cheapest first, fused by RRF, each contributing named
  evidence: (L0) names, folders, metadata; (L1) codebook, tags, page
  entities, mentions, aliases, units, projects; (L2) full text over chunks;
  (L3) semantic over embeddings, only when L0–L2 are thin or the query has
  meaning words nothing matched; (L4) model reasoning, Ask only.
- R4.3 Entity pivot: a query that names an asset resolves it (registry +
  aliases + spelling resolver) and returns everything related, grouped by
  relationship: drawn on (with sheet and position), mentioned in (with
  sentence), tagged to, filed under, in project.
- R4.4 Scope and type filters from the query: unit, folder, project, doc
  type ("drawings for X35" hides inspection reports *with a count*).
- R4.5 Every result carries its evidence list and its source layer ("read
  by vision, Aug 2026"; "never read"). Coverage is reported per scope with
  a one-click, priced "read these" action.
- R4.6 Opens land on the page: a P&ID result opens the sheet with the tag
  ringed (page entity x,y → drawing locate ring).
- R4.7 The browser finder index stays as the client cache for L0 only.

### R5 — Equipment linkage
- R5.1 Bridge runs for every container (R3.4); registry, document tag
  column, and unit all populate from one read.
- R5.2 Aliases are taught centrally (Admin/DocCtrl) and used everywhere:
  registry lookup, finder, bridge, proposer, Ask. One alias table semantic
  across `asset_aliases` and `finder_aliases` (merge or bridge them).
- R5.3 Asset page shows all edges with evidence and lets a human confirm,
  dismiss, or correct each; corrections are human edges and win.

### R6 — Projects linkage
- R6.1 Projects can be scoped to plants/units/systems/assets
  (`project_scope` edges), by hand and by the resolver (R3.7).
- R6.2 Project folders in Documents link to the project node; the project
  page shows its documents, drawings, assets, and unit from edges, not
  only from checkouts.
- R6.3 The Intelligence graph draws projects through these edges, so a
  project with no checkouts is no longer an island.

### R7 — Documents graph ↔ global graph
- R7.1 The Documents graph is the library-rooted lens of the global graph
  (R2.4), not a second graph. Drill-down, honing, rank badges, and
  in-place open stay.
- R7.2 "Open in the global view" from any node switches lens without
  losing the node.
- R7.3 Noise rules on every lens: start collapsed, expand level by level
  up to a budget, badge what is closed with a count, dim everything not on
  the path to a hit, never draw an edge without a reason.

### R8 — The Thor drive (external shares)
- R8.1 Phase A (shipped): pasted listings, paths only, searchable, shown
  as prospects "not in the system".
- R8.2 Phase B: a scanner that walks the share and reports hashes, sizes,
  dates, duplicates, and resolver guesses per file, without reading
  content. Files whose hash is already in the system are identified
  instantly.
- R8.3 Phase C: prioritised content reads (copier-named scans, probable
  drawings), on the cheap vision tier, with a price shown, then guided
  import into the right home with keep-and-link to the original path.

### R9 — Cost and privacy guardrails
- R9.1 No model call in plain search. Semantic only on submit and only
  when needed; cache per query.
- R9.2 Vision on the cheap tier, metered per user, capped monthly (as
  today).
- R9.3 Nothing outside linked sources is read without a human pressing a
  priced button, except names and paths.

### R11 — Activity awareness ("what is going on with X35 / in the crude tank farm?")
- R11.1 The find service has an **activity layer** alongside documents:
  for the resolved entity (asset, unit, area, project) and the documents
  linked to it, return work in flight — open drafting requests (tickets)
  that name it or sit on its documents or unit; active checkouts of its
  drawings (who, since when, under which project); markup requests; holds;
  projects scoped to it (R6); upcoming milestones. Grouped as "Happening
  now", each with who and when.
- R11.2 Unit- and area-level roll-up: "all projects in the crude tank
  farm" is the union of projects scoped to that unit/area (R6) and projects
  whose checked-out or linked documents are drawn on / filed under it.
- R11.3 Privacy posture: the system reports **work that touches controlled
  records, units, and projects** — things that already carry an audit
  trail — never personal content. A markup on someone's desk is unknown
  until it is a markup request or a checkout in the system; the product's
  job is to make the sanctioned path the easiest one, not to watch people.
- R11.4 A supervisor-facing "What's going on in <unit>" view is a lens of
  the same data (R2.4), not a new report.

### R10 — Verification
- R10.1 Golden queries, pinned as tests, grow with every real query the
  owner types. Current set: U1-A born heater pilot valve 2018; 10-1-15 vs
  EP10-1-15; crude P&ID sheet 5; PID-001; P-101 vs F-101; typo and
  prefix cases; layout non-overlap.
- R10.2 Every proposer and the resolver are pure functions with tests;
  I/O is a thin shell.

## 6. Phases (each useful alone, in order)

| Phase | Delivers | Done when |
|---|---|---|
| 0 (shipped) | Documents › Graph: finder parse + evidence ranking, balloon-tree map, drill-down, honing, in-place open, drive listings, finder aliases | Merged 2026-10-14 |
| 1 | Hash as universal key (R1); folders as nodes with unit edges (R2.3) | A copy of an indexed drawing anywhere shows "read"; every folder under "20 - Crude" knows its unit |
| 2 | Find service over L0–L2 with evidence (R4.1–R4.5); Documents graph, Cmd+K, equipment page call it | "drawings for X35 in crude" returns drawn-on / mentioned-in / tagged-to / filed-under groups, inspection hidden with a count |
| 3 | Resolver on every upload/folder event; bridge and proposer everywhere; alias proposals (R3, R5) | Uploading `born-u1a.pdf` into any folder proposes unit + asset edges; Review shows them with evidence |
| 4 | Project scope edges and inference (R6); Intelligence graph draws projects | A project page lists its unit, assets, and drawings without a single checkout |
| 5 | One graph store + lenses (R2.1, R2.4, R7) | The same node id selected in Documents graph and Intelligence graph; "open in global view" works |
| 6 | Convention watchdog with keep-and-link (R3.6) | Creating "Dave's stuff / OC74321.pdf" prompts a home and links it there |
| 7 | Page-level landing (R4.6); semantic layer joined (L3); coverage + priced read (R4.5) | A P&ID hit opens on sheet 7 with X35 ringed |
| 8 | Thor scanner and guided import (R8) | A 20-year share is triaged: duplicates, known-by-hash, probable drawings, copier scans |

## 7. Decisions already made

- No network crawling from the app. External shares enter by pasted
  listing now, scanner later.
- Only Admin and DocCtrl teach aliases and paste listings.
- The Documents graph lives under Documents (a tab next to Table), not
  under Intelligence; it becomes a lens of the global graph, not a copy.
- Physics layouts are out; deterministic non-overlapping layouts only.
- Opening a file never leaves the page you were on.
- Vercel previews build for pull requests and `claude/*` branches.
- The finder migration (`20261019_file_finder.sql`) must be applied to
  production by the owner; the app degrades to browser storage until then.

## 8. Open questions for the owner

1. Should a *discovered* asset (found on a drawing, not in the registry)
   be visible to everyone immediately, or only after Review?
2. When the watchdog offers "file it there", may it move the file, or only
   link? (Recommendation: link only; moves are human.)
3. Which project identifier is canonical: AFE number, project code, or
   name? The resolver needs one to key on.
4. Should `asset_aliases` and `finder_aliases` be merged into one table,
   or bridged? (Recommendation: merge; one place to teach.)
5. Retention of drive listings: keep forever, or expire after import?

---

## Appendix A — Operating procedure today: syncing a unit without burning tokens

Scope is the whole cost control. Nothing outside a linked **source** is
ever read. An invoices folder that is never linked costs nothing, forever.

1. **Intelligence › Setup.** Connect the AI key (your money, your cap), set
   the monthly cap, and make sure the Site Codebook knows the unit codes,
   equipment prefixes, and drawing-number format. The codebook is what
   turns "2002-D-2001" into "Crude, P&ID" for free.
2. **Intelligence › Knowledge › New library**, e.g. "Crude unit drawings".
   One library per purpose keeps answers and costs legible.
3. **Sources panel › Link a source.** Link the *folder subtrees* that
   matter — `Drawings / P&IDs / 20 - Crude` and `Equipment / Crude` — not
   the whole document library. Linking queues every controlled PDF in
   those folders as a pending mirror (same bytes, no copy). This is the
   moment cost is decided.
4. **Index.** Text-layer pages are extracted with no AI call. Vision runs
   only on pages that have no readable text (SHX AutoCAD exports, scans),
   on the cheap tier, on the sponsor's key, and stops at the monthly cap.
   The library option "read every page with vision" is off unless you turn
   it on. Index while you watch (the library page, resumable) or let the
   nightly maintenance cron drain it.
5. **Bridge (automatic on index completion).** Tags read on each sheet are
   decoded to the unit via the drawing number, reconciled against the
   registry (unknown tags become *discovered* assets with provenance), and
   written onto the document's equipment column. Anything that can't apply
   waits in **Intelligence › Review**.
6. **Review.** Approve or dismiss the proposed equipment links and document
   links. Dismissals are remembered; the engine never nags twice.
7. **Teach aliases** as you notice them (Equipment page today; Documents ›
   Graph › Aliases for finder terms). Every alias improves every later step.
8. **Semantic index (optional, priced).** Intelligence › Knowledge ›
   library › Semantic index. Only needed for meaning questions ("what holds
   the pump down"); tag and code search never needs it.
9. **Re-sync is automatic.** A rev-up of a linked drawing re-indexes only
   that document. A document moved out of the source is dropped. The cron
   keeps sources in lockstep nightly.

What the roadmap changes: steps 3–6 become one resolver event on upload
(R3) so the bridge runs for every container, step 7 gets ingestion-time
alias proposals (R3.5), and the find service (R4) reads what steps 4–5
produced from every search box, not only Ask.
