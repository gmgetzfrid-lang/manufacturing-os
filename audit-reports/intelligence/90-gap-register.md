# 90 · Gap register — build specs

**12 capabilities, consolidated from 182 surviving design proposals.**

Numbered from **301** so they never collide with `roles-and-permissions`
(`GAP-1`…`GAP-15`), `drafting-flow` (`GAP-101`…`GAP-114`) or `notifications`
(`GAP-201`…`GAP-207`).

> Build work. Each carries a verdict, scope, design, dependencies, acceptance
> criteria and a `Do not` list naming the specific wrong turn. Held to the
> evidence bar in [`../README.md`](../README.md) and `DEC-29`. Build order is in
> [`99-fix-sequencing.md`](./99-fix-sequencing.md).

---

## The one idea

Thirty agents worked the owner's asks independently. They converged on the same
sentence:

> **Every screen in this app works out something true about the plant and then
> throws it away on the way out the door.**

Said to a plant manager:

> Your software already reads your drawings correctly. That is the surprising
> part. When it ingests a P&ID it works out which operating unit the drawing
> belongs to by decoding the drawing number with your own numbering standard; it
> reads the title block and knows it is looking at SHT 4; it finds the equipment
> tags and knows which page each one was on; it creates the missing assets and
> files them under the right unit and the right type. All of that happens today,
> correctly, in one function. Then, in the last twenty lines, it writes a
> comma-separated list of tag names into one text column on one document and
> discards everything else — the unit it decoded, the sheet it read, the pages it
> found them on, the fact that a machine rather than a person said so. The next
> screen you open starts from nothing and has to guess.
>
> That is why the graph feels thin, why the operating areas do not fill, why the
> vessel's own page says it appears on no drawings, and why "crude unit, all of
> this goes here" cannot be expressed. **It is not a missing brain. It is a
> missing memory.**

What has to be built is one shared record of the plant that every screen writes
to and reads from, where each fact carries three things it does not carry today:

| | Meaning | Status |
|---|---|---|
| **An address** | the fact is about `2002-D-10001 SHT 4` in unit 20 — not "page 4 of a file" | `GAP-301` |
| **A source** | a machine asserted this, or a person did, and they are never the same | `GAP-303` |
| **A home** | the fact belongs to an operating area, and that area is a place you can stand in | `GAP-305`, `GAP-306` |

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-301](#gap-301) | The sheet address — promote the title block to a stored fact | **BUILD** | S | — |
| [GAP-302](#gap-302) | Widen `document_assets.source` before anything writes to it | **BUILD_NARROW** | S | — |
| [GAP-303](#gap-303) | Provenance that survives accept, edit and export | **BUILD** | M | `GAP-302` |
| [GAP-304](#gap-304) | The Bridge writes a relation, not a display column | **BUILD** | M | `GAP-301`, `GAP-302`, `GAP-303` |
| [GAP-305](#gap-305) | One unit identity — reconcile `unit:` and `cbunit:` | **BUILD** | M | — |
| [GAP-306](#gap-306) | `lib/scope.ts` — a scope is a resolved id set, not a filter | **BUILD** | L | `GAP-305` |
| [GAP-307](#gap-307) | Any door — one intake for a master list or a drawing set | **BUILD** | M | `GAP-304` |
| [GAP-308](#gap-308) | The coverage report — how you know the import was right | **BUILD** | M | `GAP-307` |
| [GAP-309](#gap-309) | Revision truth — notice when a tag leaves a sheet | **BUILD** | M | `GAP-301`, `GAP-303` |
| [GAP-310](#gap-310) | One tag grammar | **BUILD_NARROW** | S | — |
| [GAP-311](#gap-311) | Tag lookup in ⌘K — the five-second question | **BUILD_NARROW** | S | `GAP-310` |
| [GAP-312](#gap-312) | The drafting request gets an equipment field | **BUILD** | M | `GAP-304`, `GAP-311` |
| [GAP-313](#gap-313) | A server-assembled graph (GM-12's follow-up) | **BUILD** | M | a per-caller document ACL on the server (I-12) |
| [GAP-314](#gap-314) | The unit decode at create time — `documents.unit_code` stays current without a run | **BUILD_NARROW** | S | `GAP-305` |
| [GAP-315](#gap-315) | Confirmed topology as a reasoning input (FLOW-14's follow-up) | **BUILD LATER** | M | `20261155` applied (`DEC-80`) |

---

<a id="gap-301"></a>
## GAP-301 · The sheet address

**Verdict: BUILD** · Effort: **S** · Depends on: — · Findings: `BR-*`, `DWG-*`

### The requirement

> *"I'll be able to see what equipment goes to what sheet."*

What he means by *sheet* is the site's sheet — `2002-D-10001 SHT 4` — not "page 4
of a PDF". And it has to read both ways: open a sheet, see its equipment; open a
vessel, see its sheets.

### It is already extracted. One predicate throws it away.

Per-page title-block identity is written at ingest as an entity with
`kind: 'self'`, formatted `"<DWG>-SH<n>"` (`lib/knowledgeIngest.ts:281-292`).
`lib/drawingText.ts:199-225` `extractTitleBlock` returns `drawingNumber`,
`sheetNumber` and `rev`.

Then the Bridge reads the same table one predicate too narrow:

```ts
// lib/equipmentBridgeServer.ts:64
.eq("kind", "equipment")
```

The `self` rows — the sheet identity — sit on the same pages, in the same query,
and are excluded by that line.

### Scope

**In:** a first-class sheet address, resolvable from `(document, page)`, carrying
drawing number, sheet number and the revision it was read from.

**Out:** a `document_sheets` table with a row per sheet *as a node in the graph*.
See `Do not`.

### Do not

- **Do not make the sheet a node type, or create a document row per sheet.** The
  sheet belongs on the **relation** — "this asset appears on this document at
  this sheet" — not as a third entity. A sheet node multiplies the graph by the
  average sheet count and answers no question the relation cannot.
- **Do not re-derive the sheet by parsing the filename.** It is read from the
  title block, which is the authority. A filename is a convention.
- **Do not widen the `kind` filter without checking what else `self` rows carry.**
  Read `lib/knowledgeEntityKinds.ts` first.

### Acceptance

1. Given a document and a page, the system returns the site sheet address.
2. The Bridge's suggestions carry it, not just `pages: number[]`.
3. A sheet address records which document revision it was read from.
4. A test pins the `kind: 'self'` → sheet-address path end to end.

**Resolution (2026-10-02, intelligence Round G, I-11).** Reproduced first (DEC-29): with the base files (`e5de803`) swapped back in, seven of the new cases fail (no `document_assets` row after apply; AREA-4's throw "No equipment column mapped for this library…"; no sheets on a suggestion; BR-3's bare `null`; three asset-hub cases), while the regression pin (an unregistered tag still listed by its `asset_tags` containment on the hub) passes on both.

The Bridge reads the page's kind `'self'` entities on the same query as its equipment (`.in("kind", ["equipment", "self"])`). `lib/knowledgeEntityKinds.ts` was read first: `self` rows carry only a page's own title-block identity — its drawing number, and `<DWG>-SH<n>` with the raw line "DWG … SH … REV …"; the entity-kind guard test passes. `sheetAddressForPage(page, selfRows, aiRead)` returns the site sheet address: drawing number, sheet, the revision the title block declares, and the label `"2002-D-10001 SHT 4"`. When the page declared none, it falls back to the page, with that fact stated. Every suggestion carries `sheets[]`. Every relation row the Bridge writes carries `sheet_label` and `pages`, plus the revision and version it was read from (`source_revision`, `source_version_id`, 20261171). The sheet lives on the relation, never as a node or a document row. It is read from the title block, never parsed from a filename. A title block on an AI-transcribed page is marked unconfirmed (GOV-9).

**Done-when.**
1. ✓ Given a document and a page, the system returns the site sheet address (`lib/__tests__/equipmentBridge.test.ts` "given a page's self rows the system returns the site sheet address and the revision it declares").
2. ✓ The Bridge's suggestions carry it, not just `pages`.
3. ✓ A sheet address records the revision it was read from: the title block's declared `rev` on the suggestion, and `source_revision` / `source_version_id` on the relation.
4. ✓ A test pins the `kind: 'self'` → sheet-address path end to end ("GAP-301 end to end: kind 'self' rows → each suggestion carries its sheets; an AI-transcribed page is marked"; "the stored sheet_label names every sheet once, in page order").

**Scope / residual.** **Pending migrations:** `supabase/migrations/20261170_intel_roundG_document_assets_source.sql`, then `supabase/migrations/20261171_intel_roundG_provenance.sql` (hand-applied, in that order). The app deploys in either order: before 20261170 the Bridge says the relation was not recorded and keeps its column write; before 20261171 it writes the relation without the provenance columns and says so. Read both ways: open a vessel and see its sheets (the asset hub, ⌘K); open a sheet and see its equipment (the library's equipment column and the sweep's chips per document).

**Fix pass 3 (2026-10-02, review).** The residual's clause "before 20261171 it writes the relation without the provenance columns and says so" has been false since fix pass 2. Before 20261171 the Bridge writes NO 'drawing' row: `notRecorded` names 20261171, the column write still lands, and the first recompute after the paste relates the applied tags with their provenance (`GAP-304`'s fix pass 2).

**Scope / residual (corrected).** Pending migrations: `20261170`, then `20261171`, in that order. The app deploys in either order. Before either is pasted, the suggestions carry their sheet addresses, but no relation row is written, and the Bridge says why. The vessel-to-sheets direction (the asset hub, ⌘K) shows sheets once the relation is written.

---

<a id="gap-302"></a>
## GAP-302 · Widen `document_assets.source` before anything writes to it

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: — · **This is the redo-pair. It goes first.**

### Why this is a two-line migration with outsized consequences

```sql
-- supabase/migrations/20260609_phase1_normalization.sql:56
source TEXT NOT NULL DEFAULT 'jsonb_sync' CHECK (source IN ('jsonb_sync','manual'))
```

There is no vocabulary for *"a machine asserted this"*. And the trigger that
maintains the table does this on **every** `UPDATE OF asset_tags`:

```sql
-- :90-113
DELETE FROM document_assets WHERE document_id = NEW.id AND source = 'jsonb_sync';
-- then re-inserts from elem->>'tag' only
```

So three consequences, all verified:

1. Anything hung off a `jsonb_sync` row is **destroyed by the next unrelated
   edit** to that column.
2. `elem->>'tag'` is the only field the trigger reads — nothing else survives the
   round trip.
3. `AssetTag` is `{tag; type?; category?}` (`types/schema.ts:417`) — **no source
   field** — so a vision-asserted tag renders identically to a drafter-typed one.

**Several design proposals wanted to union the Bridge's output into
`documents.asset_tags`. Building that first means undoing it.** Widening the
CHECK to `('jsonb_sync','manual','drawing')` and adding `sheet_label TEXT`,
`pages INTEGER[]` makes the honest version cost the same as the dishonest one.

### Do not

- **Do not route machine output through `documents.asset_tags`.** Ever. The
  trigger will eat it.
- **Do not add a source field to `AssetTag` instead.** That JSONB column is a
  human-editing surface; the relation table is the record.

### Acceptance

1. The CHECK admits `'drawing'`, and the trigger's DELETE is scoped so it cannot
   remove non-`jsonb_sync` rows.
2. A `'drawing'`-source row survives an unrelated edit to `asset_tags`. A test
   pins exactly this.
3. `sheet_label` and `pages` exist and are nullable.

**Resolution (2026-10-02, intelligence Round G, I-11).** `supabase/migrations/20261170_intel_roundG_document_assets_source.sql`:
- **The vocabulary.** The vocabulary CHECK — 20260609's inline `document_assets_source_check`, or any CHECK naming both `source` and `'jsonb_sync'` — is dropped (only it: the review-fix pass narrowed a loop that dropped every CHECK mentioning `source`), and `document_assets_source_check CHECK (source IN ('jsonb_sync','manual','drawing'))` is re-added NOT VALID, then VALIDATED only when nothing violates it (DEC-30; the inventory counts unexpected sources). It also adds `sheet_label TEXT` and `pages INTEGER[]`, both nullable.
- **The triggers.** `documents_resync_assets()` and `assets_backfill_documents()` are re-created from their newest definition (20260609), byte-faithful except the header: SECURITY DEFINER, `SET search_path = public`, EXECUTE revoked from PUBLIC, anon and authenticated. The new write policies would otherwise refuse the trigger's own `jsonb_sync` writes for a member outside the writer tier. The resync DELETE stays `WHERE document_id = NEW.id AND source = 'jsonb_sync'`, so it cannot remove a 'drawing' or 'manual' row. `lib/__tests__/intelRoundGBridgeMigrations.test.ts` line-diffs both against 20260609.
- **The authority and the read rail** (AREA-2, DACL-11): see those records.

Nothing routes machine output through `documents.asset_tags`, and `AssetTag` gains no source field (the do-nots).

Exercised on a scratch PostgreSQL 16 (stubbed Supabase roles, `auth.uid()` and role helpers; the cluster was deleted afterwards). Both files were pasted twice in order (20261170, 20261170, 20261171, 20261171); every probe was true each time, and the second paste changed nothing. That idempotence claim did not cover 20261170 re-pasted AFTER 20261171, which dropped 20261171's `document_assets_drawing_is_machine` while its probe stayed true — corrected in the fix pass below. Cases:
- (1) The service role writes a 'drawing' row.
- (2) A Drafter outside the writer tier edits `asset_tags` (two tags, then cleared, then re-tagged). The definer trigger re-derives the `jsonb_sync` rows each time and the 'drawing' row survives every edit.
- (3) A Viewer's manual insert is refused, and a Viewer's delete affects 0 rows.
- (4) A Manager's manual insert lands; a 'drawing' or 'jsonb_sync' insert by the Manager is refused.
- (5) A Manager's update or delete of the 'drawing' row affects 0 rows; deleting a `jsonb_sync` row affects 1.
- (6) An upsert onto the 'drawing' pair is refused ("(USING expression)").
- (7) A Supervisor held only in `roles[]` links (additive).
- (8) A writer's new asset backfills its `jsonb_sync` rows (the definer function).
- (9) DACL-11: a Viewer sees only the normal document's rows in `document_assets` and in `project_documents`; an Admin sees both, the private one included. A Manager cannot link the private document.
- (10) `anon` and `authenticated` calling either sync function get "permission denied".
- (11) CB-2: a Viewer's insert into `document_equipment_suggestions` is refused (20261128's policy); an Admin's lands.

20261171:
- (P1) A Manager's manual insert claiming `asserted_by 'machine'`, a model, a revision and `vanished_at` is stamped `human`, with their uid, and no model, revision or vanished mark.
- (P2) A service-role 'drawing' insert with no `asserted_by` lands `machine` and keeps its model and revision. A service-role 'drawing' insert claiming `human` lands `machine`. With the stamping trigger disabled, the CHECK refuses a 'drawing' row as `human`.
- (P3) A person's upsert onto a 'drawing' pair is still refused.
- (P4) A person's `asset_tags` edit re-derives `jsonb_sync` rows stamped `human` with the editor's uid.
- (P5) With seqscan off, `EXPLAIN` uses `transmittals_items_path_gin` for `items @> …`, `tickets_metadata_path_gin` for `metadata @> …`, and `tickets_source_document_id_idx` for `metadata->'source_document'->>'id' = …`.

Inventory on the seeded rows: the before and after counts matched the seed.

**Done-when.**
1. ✓ The CHECK admits `'drawing'`, and the trigger's DELETE cannot remove a non-`jsonb_sync` row (the probe checks the function body; the lineDiff test pins it).
2. ✓ A `'drawing'` row survives an unrelated edit to `asset_tags`. `lib/__tests__/equipmentBridge.test.ts` "after the Bridge applies, a person edits asset_tags (another tag, then the same tag, then clears it) — the drawing rows stay", against the trigger transcribed from the SQL ("the transcription is the SQL's"), plus scratch-database case 2.
3. ✓ `sheet_label` and `pages` exist and are nullable.

**Scope / residual.** Pending migration: `supabase/migrations/20261170_intel_roundG_document_assets_source.sql` (first of the pair; then 20261171).

**Fix pass (2026-10-02, review).**
- **Re-paste after 20261171.** 20261170's drop loop now drops only the vocabulary CHECK (`conname = 'document_assets_source_check'` OR a definition naming `source` and `'jsonb_sync'`), and its probe counts only that CHECK. `lib/__tests__/intelRoundGBridgeMigrations.test.ts` "a re-paste after 20261171 drops ONLY the vocabulary CHECK — document_assets_drawing_is_machine survives …" evaluates the loop's predicate over the three CHECKs as PG16 deparses them.
- **The regression top rule: a person's `asset_tags` link is never lost to a drawing row on the same pair.** While a 'drawing' row holds a (document, asset) pair, the resync trigger's `jsonb_sync` insert for a person's `asset_tags` tag hits `ON CONFLICT DO NOTHING`; removing the drawing row (Dismiss, "It left the sheet", a column removal) used to leave no row at all. `removeDrawingRelations` now reads the document's `asset_tags` and, for a pair it names (matched as the trigger matches: `normalize_tag(elem->>'tag')` = the asset's `tag_normalized`), turns the row into exactly the synced link the trigger would have written (`source 'jsonb_sync'`, the person's spelling, no sheet, no pages, provenance reset to a person's) instead of deleting it; the rest are deleted. The audit row names both. A person's manual Link refused 23505 on a drawing pair goes through `POST action "adopt"` (`adoptDrawingRelation`): the row becomes theirs (source `manual`, `asserted_by` human, their uid, the sheet kept), audited `EQUIPMENT_BRIDGE_RELATION_ADOPTED`; Dismiss and the vanished review never remove a manual row. The registry drawer's Link calls it; the graph's Connect and the shape wizard (I-14's files) do not yet.
- Tests: `lib/__tests__/equipmentBridge.test.ts` "reproduction → fix: Dismiss of the drawing's E-22 leaves the person's synced link (jsonb_sync, their spelling), and says so", "'It left the sheet' keeps the person's synced link the same way", "a pair the person did not tag is removed outright", "a person's Link refused 23505 on the drawing's pair: adopt makes it theirs, and a later Dismiss leaves it"; route: "adopt: a person's Link refused 23505 on a drawing row makes the row theirs; …". Each fails on the pre-fix library.
- Scratch PostgreSQL 16 (a new cluster, deleted afterwards), stub schema plus the real 20260609, 20261170 and 20261171: every probe true; after 20261170 → 20261171 → 20261170 → 20261171 the three CHECKs (`asserted_by_check`, `drawing_is_machine`, `source_check`) are all present and validated. Cases: (F1) the service role writes two 'drawing' rows; a Drafter types "e 22" into `asset_tags` and the trigger's insert is skipped (both rows stay 'drawing'). (F2) The lib's conversion as the service role turns the E-22 row into `jsonb_sync` "e 22", `asserted_by` human, no model; the stamping trigger keeps it as written; the Drafter's next `asset_tags` edit re-derives it (DELETE + insert) as `jsonb_sync`, stamped with the Drafter's uid, while V-101's drawing row stays. (F3) Adopt as the service role: V-101 becomes `manual`, human, the person's uid, the sheet label kept; the CHECKs hold. (F4) A drawing row's "still there" (`vanished_at` cleared, `presence_confirmed_on` set) stays `machine`. (F5) A person's direct UPDATE of a drawing row to `manual` still affects 0 rows (RLS).

---

<a id="gap-303"></a>
## GAP-303 · Provenance that survives accept, edit and export

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-302`

### The requirement he did not state

He is building for PSM. A regulator's first question is *"where did this come
from"* and the second is *"has it ever been wrong, and how do you know you caught
it."*

The codebase already has the instinct — `origin: 'manual' | 'drawing'` on assets,
`proposed`/`confirmed` on flows, "measured vs AI-estimated" on pipe traces,
`discovered_from` on discovered assets. **Verify each reaches the UI**: at least
one does not. `lib/equipmentBridgeServer.ts:214` writes
`discovered_from: { documentId, pages }` and nothing reads it.

Two places the distinction is lost outright:

- **On the drawing viewer, an AI-written equipment tag is pixel-identical to one
  a drafter typed.** Rated TRANSFORMATIVE by the critique and it is a
  five-character render change once `GAP-302` lands.
- **Correcting a mis-read tag leaves no trace it was ever wrong.** The record
  shows a tidy asset identical to one nobody ever doubted.

> **Why he may not have asked:** he is the QA/QC *and* the drafting manager at
> his own site — when he fixes a tag, he **is** the record. He is building for
> facilities where that is not true.

### Do not

- **Do not let accept erase that something was proposed.** Accepting is an event
  with an actor and a time, not a state change that overwrites history.
- **Do not present a confidence score as provenance.** A number is not a source.
- **Do not let AI-derived data drive a compliance artifact, a hold, or an MOC**
  without a human assertion in between. Take that as a hard rule.

### Acceptance

1. For any asset, the system produces the complete story of how it came to be
   believed — asserted by whom or read from which sheet of which revision.
2. AI-derived and human-asserted are visually distinguishable everywhere both
   render, including the drawing viewer and the graph.
3. A correction is recorded as a correction.
4. Provenance survives export and restore.

**Partial (2026-10-02, intelligence Round G, I-11).** `supabase/migrations/20261171_intel_roundG_provenance.sql` gives every relation row its source:
- `asserted_by` (`machine` | `human`, NOT NULL, default `human`; every existing 'drawing' row backfilled `machine`; CHECK `document_assets_drawing_is_machine` validated: a 'drawing' row is always a machine's);
- `asserted_by_user`;
- `model` (the AI model that transcribed a page the tag was read on; NULL for a text layer);
- `source_revision` / `source_version_id`;
- `vanished_at` / `superseded_at` (GAP-309).

A BEFORE INSERT OR UPDATE trigger (`document_assets_stamp_assertion`; not SECURITY DEFINER, `search_path` pinned) stamps a signed-in person's write as `human` with their uid and clears every machine field, so a person cannot forge a machine reading. A service-role write keeps what it says, so a restore round-trips, and a 'drawing' row always lands `machine`.

Accept, edit and dismiss are events, not overwrites:
- an apply writes `EQUIPMENT_BRIDGE_APPLIED`;
- a discovery records `discovered_from` (with its door) and audits it;
- a person's rejection of a machine reading writes `EQUIPMENT_BRIDGE_DISMISSED` and `EQUIPMENT_BRIDGE_RELATION_REMOVED`, naming what the reading was (tag, sheet, pages, revision, model);
- the vanished review writes `EQUIPMENT_BRIDGE_VANISHED_REMOVED` / `_KEPT`.

No confidence score is stored or shown. Nothing AI-derived drives a hold, an MOC or a compliance artifact: the Bridge writes none.

**Done-when (acceptance).**
1. ◐ The pieces of the story are recorded and shown per link, but there is no single view yet. The asset's `origin` / `discovered_from` (the registry's Discovered filter shows the source drawing). Each link's who / which sheet / which revision / which model (the asset hub row). Every decision's audit row.
2. ◐ Distinguishable on the asset hub ("read from drawing" / "AI-read" with the model and revision), in ⌘K ("(read from the drawing)") and in the sweep (chips, "(AI-read, unconfirmed)"). ✗ Not done here: the drawing viewer and the graph (the graph is I-14's and I-15's; `lib/orgGraph.ts` reads the relation without `asserted_by`).
3. ✓ A correction is recorded as a correction: the removal's audit row carries the machine reading it removed, and the ledger keeps the dismissal with who, when and the revision (`lib/__tests__/equipmentBridge.test.ts` "dismissing an applied tag removes its drawing relation, records the decision, …"). Fix pass: the correction audit inserts (`EQUIPMENT_BRIDGE_RELATION_REMOVED`, `_DISMISSED`, `_VANISHED_REMOVED`, `_VANISHED_KEPT`, `_RELATION_ADOPTED`, and the column dismissal's) were swallowed; a failed one is now returned to the caller as `auditError` and shown in the sweep ("a correction whose audit row cannot be written is reported to the caller, not swallowed"). A column removal is recorded too (`via: 'column'`, BR-5), and so is a person adopting a drawing row.
4. ✓ Provenance survives export and restore. The export reads `document_assets` with `select("*")` (`lib/dataExport.ts`; the table is in `lib/exportTables.ts`). The restore writes with the service role (`app/api/admin/restore/apply-table`), which the stamping trigger leaves as written. Scratch-database case P2: a service-role row keeps its model and revision; a 'drawing' row lands `machine`.

**Scope / residual.** Handed: the drawing viewer's tag overlay (the drawing surfaces' owner) and the graph's edge styling by `asserted_by` (I-14 / I-15). A single per-asset "how we came to believe this" view is not built. Pending migration: `supabase/migrations/20261171_intel_roundG_provenance.sql`, after 20261170.

**Assigned (2026-10-13, integrator, I-11 merge, DEC-31).** intelligence I-15 GRAPH SERVER ASSEMBLY (the graph's edge styling by `asserted_by`) and I-26 BRIDGE REMAINDERS (the drawing viewer's tag overlay).

**Fix pass 2 (2026-10-02, review).** Three gaps against this record:
- **Order (99-fix-sequencing Phase 2; GAP-304 depends on this).** With 20261170 pasted and 20261171 not, `syncDrawingRelations` retried the 'drawing' insert without the provenance columns. A relation could then exist before its provenance: a backfill that cannot recover what it did not record. Now a missing provenance column means nothing is written. `notRecorded` says the relation needs 20261171 (paste 20261170, then 20261171), the column write still lands, and the first recompute after 20261171 relates every applied tag with its provenance. `provenanceDropped` is gone. Both migration headers say so. Test: `lib/__tests__/equipmentBridge.test.ts` "before 20261171 NO drawing row is written — a relation never exists before its provenance …" (fails on the fix-pass-1 library).
- **Audited.** The `EQUIPMENT_BRIDGE_APPLIED` audit (an apply: registry assets and relations) and the `EQUIPMENT_BRIDGE_DISCOVERED` audit (the knowledge door) were still fire-and-forget. Both are checked now. A refused insert returns `auditError` (`ApplyResult.auditError`; the discover result's `auditError`), shown by the sweep modal and the coverage report. Tests: "the apply's audit row and the knowledge door's are checked: a refused insert is said to the caller"; `lib/__tests__/coverageReportRender.test.ts` "a discovery that landed but whose audit row was refused is said …"; `lib/__tests__/equipmentSweepModalRender.test.ts` "an apply or a dismissal whose audit row was refused stays on screen after the re-read".
- **A person's assertion shown as one.** While a 'drawing' row holds a pair, the resync trigger skips the person's `jsonb_sync` row (confirmed on scratch PostgreSQL 16 by the review). The relation alone therefore said "machine, not typed by a person" for a tag a drafter had typed. The asset hub now reads the linked documents' `asset_tags`. A pair the document's own tags name is shown "tagged · also on drawing": no "Not typed by a person", and the vanished mark says the link stays because the document's tags name it. ⌘K says "(tagged, and read from the drawing)". Tests: `lib/__tests__/assetHubRelation.test.ts` "the drawing row holds the pair while the document's asset_tags name it: …" and `lib/__tests__/globalSearchTags.test.ts` "a sheet read off an AI transcription is '(AI-read, unconfirmed)'; a pair the document's asset_tags name says a person tagged it too". Both fail on the fix-pass-1 files.

Acceptance 2 gains the ⌘K and coverage-report AI-read marks (GOV-9's fix pass 2). Acceptance 3: every Bridge write's and every correction's audit insert is now checked.

**Fix pass 3 (2026-10-02, review).**
- **What `asserted_by_user` records.** It was documented as "the person, when a person asserted it". For a `jsonb_sync` row it is not that. `documents_resync_assets` deletes and re-inserts every synced row of a document on each `asset_tags` edit, and the BEFORE INSERT stamp sets the uid of whoever made that edit, for all of the document's tags, including tags other people typed. `assets_backfill_documents` stamps the asset's creator on links to documents someone else tagged. The 20261171 header now states the semantics. For a 'manual' row it is the person who linked it, and a drawing pair a person made theirs through `adopt` records that person. For a 'jsonb_sync' row it is the person whose write last re-derived the row: the latest editor of that document's equipment tags, or the asset's creator, not necessarily who typed the tag. It is NULL on a 'drawing' row, and on a synced row the Bridge handed back to the person's tags. No screen shows the uid; export and restore carry it with that meaning. The SQL is unchanged.
- **A person's assertion kept at transition-in.** `lib/transitionIn.ts` now sends a drawing-held pair through `adopt` (`AREA-2`'s fix pass 3), so a controller's link is recorded as theirs (`asserted_by` human).

**Partial (2026-10-20, intelligence Round G).** I-15 GRAPH SERVER ASSEMBLY — the graph limb of acceptance 2 (assigned 2026-10-13). Reproduced first (DEC-29): `lib/orgGraph.ts:552` / `:683` on `8224f80` read the relation as `id, document_id, asset_id`, so the graph drew a machine's reading and a person's link identically. What landed:
- `lib/orgGraph.ts` reads `document_assets` in three tiers (`DA_COL_TIERS`, `:419`): with `asserted_by` / `model` (20261171), with `source` / `sheet_label` / `pages` (20261170), then the pair alone; a database that predates a tier answers 42703 / PGRST204 and the next is read, so the map draws exactly what it drew before that file. `relationOf` (`:899`) puts on the doc ↔ asset edge only what the row says: `sheet`, `pages`, `assertedBy` (`asserted_by`; before 20261171 a 'drawing' row is a machine's by GAP-302), and `aiRead` when the machine's page was read off an AI transcription (the row names a model). Org-wide and scoped reads both.
- `components/graph/graphTheme.ts`: `edgeRgbFor` draws a machine reading in its own colour (`TAG_MACHINE_RGB`, orange; a person's link keeps the shared-equipment slate), in 2D and 3D alike (both renderers already colour every edge through `edgeRgbFor`); `edgeLabelFor` labels it "Read from the drawing · <sheet>" and, AI-read, "(AI-read, unconfirmed)" (`AI_READ_MARK`, the mark the asset hub, the sweep, ⌘K and the coverage report use); the legend lists it (`tag-machine`).
- Tests: `lib/__tests__/intelRoundGGraphServerAssembly.test.ts` "GM-14 limb 2 / GAP-303 graph limb — …" (six cases: the edges, the two fallback tiers org-wide and scoped, `relationOf`, the theme).

**Done-when (acceptance), this pass.**
2. ◐ The graph ✓ (a machine reading is drawn and labelled apart from a person's assertion; the AI-read mark carried). ✗ Not done here: the drawing viewer's tag overlay — intelligence I-26 BRIDGE REMAINDERS (assigned 2026-10-13), unchanged.
1, 3, 4. Unchanged from the I-11 record (1 ◐ — no single per-asset story view; 3 ✓; 4 ✓).

**Scope / residual.** Stays open for the drawing viewer (I-26) and acceptance 1's single view (unowned in the plan before this pass; recorded on the I-11 Partial).

**Assigned (2026-10-20, integrator, I-15 merge, DEC-90; DEC-31).** Acceptance 1 — the single per-asset "how we came to believe this" provenance view — to intelligence I-32 PROVENANCE VIEW AND WIZARD ADOPT (allocated by the integrator at the I-15 merge), with `AREA-12` (the shape wizard's adopt on 23505). Acceptance 2's drawing-viewer limb stays with I-26 BRIDGE REMAINDERS. `components/graph/graphTheme.ts` is outside I-15's file list (the integrator's file list named the page and `lib/orgGraph.ts`); the change there is additive (two exports, one legend row, one branch in each helper).

*Fix pass (2026-10-20, review of I-15).* The review found the sheet and the AI-read mark reached the member only through the path-finder's step list (`edgeLabelFor` had one caller, the path steps' "via" text); the map's renderers use the colour alone and the peek showed no edge label. Now the peek's "Connected in this view" list carries, beside each node a document ↔ equipment link reaches, what that link says in the theme's own words (`edgeLabelFor`: "Read from the drawing · SHT 4 (AI-read, unconfirmed)"), also as the row's hover title (`app/(protected)/graph/page.tsx` `linkNotes`, `:810`; `components/graph/NodePeek.tsx` prop `linkNoteOf`, `:40`, rendered at `:202`). A person's link with no sheet adds nothing. And a drawing-held pair a person has just adopted from the graph is redrawn as theirs at once (slate, "Shared equipment · <sheet>", no AI-read mark — `withAdoptedTag`, `page.tsx:114`), where it kept the machine's colour and label until the next load. Tests: `lib/__tests__/graphPageRender.test.ts` "GM-14 / GAP-303 graph limb (fix pass) — …" (the note and title on the peek row; nothing for a plain link) and "AREA-2 … fix pass: after the adopt the drawing's edge IS the person's …". `components/graph/NodePeek.tsx` is outside I-15's file list too; the change is one optional prop and its line under each row.

**Partial (2026-10-20, intelligence Round G).** Package I-26 BRIDGE REMAINDERS: the drawing viewer's tag overlay (acceptance 2's viewer limb). Both drawing viewers' equipment-tag ribbon (`components/assets/EquipmentTagsStrip.tsx`, mounted by `components/viewers/FullScreenViewer.tsx` and `components/viewers/MultiDocViewer.tsx`, which now pass the document and its own equipment tags) tells a machine reading from a person's assertion, worded as the asset hub words it: a tag the equipment sweep read off the drawing is marked "AI-read" (with the transcribing model) or "read from drawing" (the PDF's own text), with the sheet and revision in its tooltip ("… on 2002-D-10001 SHT 4 (AI-read, unconfirmed), Rev B. Whether a person also typed it into this tag column is not recorded."); a tag the document's own equipment tags name too reads "tagged · also on drawing"; an unmarked chip is a person's, as it always read. Review fix pass: the ribbon's chips come from the document's metadata tag columns, which a person types and the Bridge's apply writes, and nothing records which — so a chip only the sweep's reading names is marked for how it was READ, never "Not typed by a person" (the first pass said that of a tag a person may have typed into the column, DEC-29); `lib/__tests__/intelRoundGI26ViewerProvenance.test.ts` "REGRESSION (review): a chip a person typed into the tag column that the sweep ALSO read is never told 'Not typed by a person' …". The source is the relation's 'drawing' rows for that document (`lib/drawingTagProvenance.ts`, new), read under the viewer's own RLS (DACL-11's rail), with the provenance columns dropped one step at a time on a database before 20261171. A read that fails marks nothing; with no document passed (the Inspector and every other mount) nothing is read and the chips render exactly as before. Tests: `lib/__tests__/intelRoundGI26ViewerProvenance.test.ts` (9).

**Acceptance.**
1. ◐ Unchanged: the pieces are recorded and shown per link; no single per-asset view.
2. ◐ Distinguishable on the asset hub, in ⌘K, in the sweep, and now in the drawing viewer (✓ here). The graph's edge styling by `asserted_by` landed with I-15 (its Partial above: a machine reading coloured and labelled apart, the AI-read mark carried); what remains of the graph limb — every label the graph shows that comes from a title-block reading carrying the AI-read mark (`GOV-9` criterion 4's graph limb) — is owned by intelligence I-32 PROVENANCE VIEW AND WIZARD ADOPT, no longer I-15 (merged). Ruled by the integrator at the I-26 merge, 2026-10-20 (DEC-90).
3. ✓ (2026-10-02).
4. ✓ (2026-10-02).

**Scope / residual.** OPEN on the graph limb's remainder (intelligence I-32 PROVENANCE VIEW AND WIZARD ADOPT; Ruled by the integrator at the I-26 merge, 2026-10-20 (DEC-90)) and on acceptance 1, the single per-asset "how we came to believe this" view — opened as its own finding, `GAP-316` (below), so it is planned rather than left on this record (DEC-31); it is I-32's too (assigned at the I-15 merge). No migration.


**Resolution (2026-10-20, intelligence Round G).** Package I-32 PROVENANCE VIEW AND WIZARD ADOPT — the two limbs left on this record: acceptance 1 (the single per-asset view, opened as `GAP-316`) and the graph remainder of acceptance 2 (`DEC-90` rulings (1) and (2); assigned at the I-15 and I-26 merges). Reproduced first (`DEC-29`): on `a21c718` no single per-asset view existed (`GAP-316`'s resolution has the detail). The org graph also disagreed with the asset hub on two kinds of link:
- **A machine reading a person also tagged the document with.** The hub showed it as "tagged · also on drawing". The graph drew it orange: "Read from the drawing (not yet a person's link)" (`lib/orgGraph.ts relationOf` read only the row).
- **A person's link carrying the sweep's sheet address.** This is a pair adopted through the Bridge, which keeps `sheet_label` and clears `model` (`HUMAN_PROVENANCE`). The graph labelled it "Shared equipment · SHT 4" as a plain fact. The I-15 fix pass's `withAdoptedTag` dropped the mark at once.

With the base `lib/orgGraph.ts` and `components/graph/graphTheme.ts` put back, the six graph cases of the new `lib/__tests__/intelRoundGI32Provenance.test.ts` fail, and the seven other selected cases pass.

What landed:
- **Acceptance 1:** the provenance view, `GET /api/assets/provenance` and `components/assets/AssetProvenancePanel.tsx` on the asset hub. See `GAP-316`'s resolution.
- **The graph remainder.** Machine-read vs person-asserted, and every sheet mark, now come from one function set, `lib/relationProvenance.ts`, which the provenance view uses too:
  - `lib/orgGraph.ts`: `relationOf(row, personTagged)` marks a machine reading whose document's own equipment tags name the asset's tag `personAlso`. It marks the sweep's address on a person's link `sheetUnconfirmed` (`sheetReadingOf`). The tags come from `readMachineDocTags`: one keyed read of `documents.asset_tags`, only for the documents a machine reading links, under the same client as every other read, org-wide and scoped alike. A read that fails marks nothing (the edges stay the sweep's alone, as before) and the map says so in its notes. `GraphEdge` gains the two optional fields; the wire carries them unchanged (`packGraphPayload` packs every extra).
  - `components/graph/graphTheme.ts`: a `personAlso` edge takes the person's slate and the label "Tagged, and read from the drawing · <sheet>". A `sheetUnconfirmed` sheet reads "(read by the equipment sweep, unconfirmed)", the `SWEEP_SHEET_MARK`. `AI_READ_MARK` is re-exported from the shared module with the same words.
  - `app/(protected)/graph/page.tsx`: `withAdoptedTag` redraws a just-adopted pair with the sweep's address unconfirmed, as the next load draws it.
  - `app/(protected)/assets/[tag]/page.tsx`: the hub's sheet chip carries the same mark on a person's link.

Tests:
- `lib/__tests__/intelRoundGI32Provenance.test.ts`:
  - the agreement matrix — for seven kinds of relation row, the view's standing and sheet mark and the edge's colour and label say the same thing;
  - the org graph: a regression pin, `personAlso`, `sheetUnconfirmed`, scoped, and the failed tags read.
- `lib/__tests__/intelRoundGI32ProvenancePanel.test.ts`: the hub chip.
- `lib/__tests__/graphPageRender.test.ts`: the adopt case now expects `sheetUnconfirmed` and "Shared equipment · SHT 4 (read by the equipment sweep, unconfirmed)", still slate and with no AI-read claim (`DEC-90` ruling (2)).

**Done-when (acceptance).**
1. ✓ For any asset, the system produces the complete story, asserted by whom or read from which sheet of which revision (`GAP-316`).
2. ✓ AI-derived and human-asserted are distinguishable everywhere both render, the drawing viewer (I-26) and the graph included. The graph's edges now agree with the provenance view on machine-read vs person-asserted, and on which sheet addresses are unconfirmed.
3. ✓ (2026-10-02) unchanged.
4. ✓ (2026-10-02) unchanged. The view reads the records, and adds and changes nothing exported or restored.

**Scope / residual.** One remainder sits outside this package's surfaces. ⌘K (`lib/search.ts` / `lib/globalSearch.ts`) and the coverage report (`lib/bridgeCoverage.ts` / `components/assets/CoverageReport.tsx`) still show an adopted pair's sheet address with no mark. It is opened as `GOV-16` (LOW, `DEC-31`; owner to be assigned by the integrator). No migration.

---

<a id="gap-304"></a>
## GAP-304 · The Bridge writes a relation, not a display column

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-301`, `GAP-302`, `GAP-303`

### The finding, verbatim

The Bridge's only output write:

```ts
// lib/equipmentBridgeServer.ts:260-277
const current = metadata[targetKey] …
.update({ metadata: { ...metadata, [targetKey]: next } })
```

A comma-joined list of tag strings, in one JSONB key, on one document. Every
relation consumer reads a **different** store. And:

```tsx
// app/(protected)/assets/[tag]/page.tsx:51-56
.contains("asset_tags", [{ tag }])
```

**The asset hub does not read `document_assets` at all.** That is why E-22's page
says "no drawings" after a sweep that worked perfectly.

Two more gates worth knowing before you touch this:

- `lib/equipmentBridgeServer.ts:190-193` — `if (!targetKey) throw` sits **above**
  the discovery block at `:197-234`. **No mapped column means zero assets
  created**, even though discovery has nothing to do with the column.
- `:219-224` — a strip-and-retry that drops `unit_code, code, origin,
  discovered_from` on error, then `:226-230` falls through to a raced lookup and
  `continue`s, producing a silent `createdAssets: 0`.

### Do not

- **Do not delete the metadata column write.** It is what the drawing row's chips
  render from. Write both; make the relation authoritative.
- **Do not move the discovery block without moving the `targetKey` throw.** They
  are independent and the ordering is the bug.
- **Do not let the strip-and-retry stay silent.** A degraded insert is
  information.

### Acceptance

1. After a sweep, the asset hub shows the drawings, the graph shows the edge, and
   the impact scan sees it.
2. Discovery works with no column mapping configured.
3. A degraded insert reports what it dropped.
4. Re-running a sweep is idempotent — a test pins it.

**Resolution (2026-10-02, intelligence Round G, I-11).** Reproduced first (DEC-29): with the base files (`e5de803`) swapped back in, seven of the new cases fail (no `document_assets` row after apply; AREA-4's throw "No equipment column mapped for this library…"; no sheets on a suggestion; BR-3's bare `null`; three asset-hub cases), while the regression pin (an unregistered tag still listed by its `asset_tags` containment on the hub) passes on both.

The relation is authoritative and the column is kept: see `BR-2` / `WIRE-1`. The `targetKey` throw is gone, and discovery runs with or without a mapped column (AREA-4). The strip-and-retry is no longer silent. A degraded insert reports which columns it dropped, per tag (`degraded` in the result, the modal and the `EQUIPMENT_BRIDGE_APPLIED` audit row). An insert that failed outright is reported (`failed`). A raced insert resolves to the winner. The backfill population is the tags applied before the relation existed. They are re-related on the library's next sweep: each recompute refreshes the relation of every applied tag still read on the current revision. The 20261170 inventory counts the documents whose library maps a Bridge column and have no relation row yet.

**Done-when.**
1. ✓ After a sweep, the asset hub shows the drawings (`lib/__tests__/assetHubRelation.test.ts`). The graph's tag edge and the impact scan see them by construction: `lib/orgGraph.ts`, `lib/impact.ts` and `lib/revisionImpact.ts` read `document_assets`.
2. ✓ Discovery works with no column mapping ("AREA-4: with NO column mapped, discovery still creates the assets and the relation is written — nothing throws").
3. ✓ A degraded insert reports what it dropped ("a degraded insert (a database before the registry columns) reports what it dropped").
4. ✓ Re-running a sweep is idempotent ("re-running the sweep and the apply is idempotent — one row per pair, the column unchanged, nothing re-created").

**Scope / residual.** **Pending migrations:** `supabase/migrations/20261170_intel_roundG_document_assets_source.sql`, then `supabase/migrations/20261171_intel_roundG_provenance.sql` (hand-applied, in that order). The app deploys in either order: before 20261170 the Bridge says the relation was not recorded and keeps its column write; before 20261171 it writes the relation without the provenance columns and says so. A library's backlog of applied tags is related on its next sweep (BR-11's resumable sweep), not by the migration: the paste writes no customer rows.

**Fix pass (2026-10-02, review).** The backfill population was `applied`, not the column: every recompute re-related applied tags a person had since taken off the mapped column (before this deploy, the only way to reject a Bridge tag). Now an applied tag no longer in the column the Bridge wrote it into is recorded as a dismissal (`via: 'column'`) and its relation removed or never created (BR-5's fix-pass block: `appliedColumn`, `planColumnRemovals`). An apply stamps the revision of the CURRENT copy (`currentReading` now uses the compute's selection — ready and at the document's current revision — through a shared `classifyCopies` / `readingOf`), never a stale ready copy listed first ("currentReading — an apply stamps the revision of the CURRENT copy, never a stale one listed first"). Every relation read and write names `org_id` (BR-1's fix pass).

**Fix pass 2 (2026-10-02, review).** The residual above was wrong in one clause: "before 20261171 it writes the relation without the provenance columns and says so". That let a relation exist before its provenance, against this finding's own "Depends on: GAP-303" and 99-fix-sequencing Phase 2. Now, before 20261171, the Bridge writes NO 'drawing' row and says the relation needs that file. The column write still lands, and the first recompute after the paste relates the applied tags with their provenance (GAP-303's fix pass 2).
- The relation's per-document reads are paged, or filtered at the database (BR-11's fix pass 2).
- A library configuration that cannot be read now stops the apply and the compute, and nothing is written (`loadBridgeConfig` returns `{ config, tagColumns, error }`). Before, a failed read was taken as "no column, discovery on": the apply created assets a library had opted out of (`createAssets: false`) and marked tags applied that never reached the mapped column. The compute throws rather than skipping only the auto-apply and the column plan, which is stricter than the review's ask: a proposal computed without the configuration would also lose the library's default unit. The sweep counts the document failed; ingest's call is already caught. Tests: "a library whose settings cannot be read: apply writes nothing …" and "…and a compute writes nothing: no proposal without the library's default unit, no column plan, no auto-apply".

**Scope / residual (corrected).** Pending migrations: `20261170`, then `20261171`, in that order. The app deploys in either order. Before 20261170, and now also before 20261171, the Bridge says the relation was not recorded and keeps its column write.

**Fix pass 3 (2026-10-02, review).** "The backlog is related by sweeps" could not be checked: the compute's relation refresh, which is that backfill, discarded its outcome. `computeForDocument` now returns it (`ComputeResult.relations`, merged with its automatic apply's). The sweep sums it into `outcomes` (`relationsWritten`, `relationsRefreshed`, `relationsKeptHuman`, `relationsNotRecorded`, `relationNote`), and the sweep modal shows the links recorded and, with the reason, the documents whose links were not recorded. A sweep now says whether the backfill was recorded. See `BR-2`'s fix pass 3 for the tests. At ingest the outcome goes to a fire-and-forget caller (I-18's `lib/knowledgeIngest.ts`); the next sweep reports it.

---

<a id="gap-305"></a>
## GAP-305 · One unit identity

**Verdict: BUILD** · Effort: **M** · Depends on: — · **This is why the pivot cannot work**

`lib/orgGraph.ts:190-194` emits `unit:<uuid>` from the `units` table. `:197-203`
emits `cbunit:<code>` from the Site Codebook. Both `type: "unit"`. **Adjacent
loops, no edge between them.**

Two independent searches confirmed nothing anywhere joins a codebook unit code to
a `units` row. **The crude unit is genuinely two dots on his graph**, and focusing
one of them can never show the other's drawings.

Compounding it: `documents.unit_code` **does not exist** (confirmed by two
differently-shaped searches). `documents.unit_id` does. So a document decoded
from its drawing number has nowhere to record the decode.

### Do not

- **Do not resolve this by inferring the edge at render time.** One proposal
  suggested parsing drawing numbers in memory during assembly — "zero migration,
  zero writes". That violates `lib/orgGraph.ts:4-5` (*"each edge is a row
  somewhere"*) and would fail the guard test another agent proposed in the same
  run. **Write the decode to a real column.**
- **Do not merge the two namespaces by deleting one.** They mean different
  things: one is a configured operating unit, one is a decoded code. Join them.

### Acceptance

1. A codebook unit code resolves to at most one `units` row, and the mapping is
   data.
2. `documents.unit_code` exists and is written by the decode.
3. The graph emits one unit node per real unit.
4. A document whose number does not decode is **reported**, not guessed — the
   discipline `lib/assetCategorize.ts:12-16` already states.

**Resolution (2026-10-01, intelligence Round G, I-13).** Reproduced first (DEC-29): `lib/__tests__/orgGraph.test.ts` against the base `lib/orgGraph.ts` draws the crude unit twice (`expected […] to not include 'unit:u1'`) with no path between a drawing filed to the operational unit and the equipment filed to the codebook unit. Decision (the plan's default — `DEC-67`, provisional number): keep both, join them as data, retire nothing. What landed:
- `supabase/migrations/20261138_intel_roundG_unit_identity.sql` — `units.codebook_code` + UNIQUE `(org_id, codebook_code)` where set (the mapping); `documents.unit_code` (+ index); `trg_documents_unit_code_guard` (BEFORE INSERT OR UPDATE OF unit_code, document_number): a person's insert lands NULL, a person's write is refused (42501), a renumber drops the old decode unless the same write sets a new one, the service role passes; `documents_total_for_org` (GM-6); and (review fix, 2026-10-01) `trg_units_codebook_code_guard` (BEFORE INSERT OR UPDATE OF codebook_code, archived OR DELETE ON units): the only policy on `units` (`units_member_all`, 20260606) lets any active member write the row, so the mapping — which decides graph identity, a unit's scope and what the decode writes into assets.unit_id — was guarded by the browser alone; now every change to it (set, cleared, released by an archive, or deleted with its row) is refused 42501 unless the caller holds a role of `ADMIN_SURFACES` "scope".writes (read from the role collection by `caller_holds_any_role`; a test pins the SQL list to `lib/adminSurfaces.ts`), the service role passes, and an archived unit holds no code (archiving releases it, so the code can be remapped — before, an archived unit kept its code under the UNIQUE index where the page could not reach it). Every object is new — no earlier migration defines any of them, so nothing is re-created (pinned by test).
- The decode is WRITTEN, never inferred at assembly: `lib/operationalGraph.ts` `planUnitIdentity` decodes every document number with the org's own codebook (`parseDrawingNumber`, I-10's one parser) and `POST /api/admin/unit-identity` writes `documents.unit_code` as its one writer (service role; authority ADMIN_SURFACES "scope".writes over the role collection; preview by default; refusals counted; audited `UNIT_IDENTITY_BACKFILL`). The same pass FILLS an empty `assets.unit_id` with the operational unit the filing (`assets.unit_code`) is mapped to; `documents.unit_id` is never written. An empty or format-less codebook writes nothing (a failed codebook load can never clear the decodes).
- Review fixes (2026-10-01). (a) **What the report names.** The pass reads every document with the service role, but the scope writer tier includes Manager and Supervisor, who see a private document only through a grant; the first cut returned up to 50 raw non-decoding numbers to them, restricted ones included. Now a document's number — or the unknown unit code it decodes to — is listed only when the caller may read it: the controller tier (the held collection, `lib/permissions` `isControllerRole`, is_org_controller's set) sees every number; anyone else sees open-visibility numbers (node_visible's NULL / 'normal' arm) and a count of the rest ("N restricted numbers do not decode (not listed)"). (b) **Fill, never overwrite.** The first cut re-pointed or cleared any `assets.unit_id` pointing at a mapped unit that disagreed with the filing, as if it were its own stale output; on a first run every such value was set by hand or by an import, and the audit kept counts only. A value already there is now kept and counted (`disagreeWithFiling`, `keptWithoutFiling`), as a document's disagreement is; 20261138's re-paste counts the same. (c) **Bounded per call.** An apply writes at most `UNIT_IDENTITY_WRITE_BUDGET` (4,000) rows per call, documents first, in parallel waves of 200-row chunks, and reports `remaining`; the panel (`runUnitIdentityBackfill`) calls again until nothing remains or a round lands nothing. The audit row is written before the writes ("started", the planned counts) and after ("finished", what landed); if the opening row cannot be written, nothing is written. A call the platform stops is reported as interrupted (with what earlier rounds landed), never as "did not run".
- Second review fixes (2026-10-01). (d) **Every write re-checks what it was planned on.** The plan is built from a read taken before the writes, and the UPDATE itself did not require the condition: a unit set by hand on an asset between the read and the write was overwritten, and a document renumbered mid-run (20261138's trigger drops its decode) was stamped with its OLD number's decode by the service role. Now an asset fill is `.is("unit_id", null).eq("unit_code", <the planned filing>)`, and a decode write is `.in("document_number", <the numbers in that write>)` — every number in one write decodes to the same value, so a renumber to another of them is still right (a number PostgREST's in-list cannot carry verbatim is matched one document at a time with `eq`; an unnumbered document with `is null`). A row that no longer matches is left as it is and counted `changed` ("changed since they were read"), never refused and never overwritten; the next round plans it afresh. (e) **The codebook is read whole.** `loadCodebookAdmin` (I-10's) is one request, cut at max-rows across every entry kind; a unit past row 1,000 read as "unknown" and every document decoded to it was CLEARED. The route now reads the unit entries itself in keyset pages and uses them as the book's unit list; if they cannot be read, nothing is planned (500). The operational units read is paged too. (f) **Which codes are taken** is read from `units` directly (`listCodebookMappings`: codebook_code set, the unit not archived, under ANY plant): archiving a PLANT does not archive its units, so a unit under an archived plant keeps its code while the default tree hides it, and the picker offered the code as free. A taken code is now disabled and names its holder and plant ("mapped to Sulfur (old) · Old Refinery, an archived plant"); the panel counts codebook units mapped over every holder.
- Third review fixes (2026-10-01). (g) **The projection is kept current in the database.** The backfill was the only writer of `assets.unit_id` and nothing re-pointed a value, its own included: a refile (`lib/assets.ts` `updateAsset`, the Bridge filling `unit_code`) or a remap of `units.codebook_code` left the old unit on the equipment for good — every later run reported it "kept", no screen sets or clears `unit_id`, `searchAssets({ unitId })` and `lib/scope.ts` kept it under the old unit and the graph tied it to both — and equipment created after a run had no unit until a manual re-run. 20261138 now carries two more objects, both new: `trg_assets_unit_id_follows_filing` (BEFORE INSERT OR UPDATE OF unit_code ON assets; not SECURITY DEFINER; search_path pinned) — a new item with no unit takes the one its filing maps to; a refiled item whose unit was the old filing's projection (or empty) takes the new filing's (none when it maps to none); a unit that disagreed with the old filing (set by hand or by an import) is kept; a write that sets `unit_id` itself is taken as written; an UPDATE naming `unit_code` without changing it fills an EMPTY unit from the mapping as it stands — the same rule as 3.'s renumber, for every writer — and `trg_units_codebook_code_follow` (AFTER INSERT OR UPDATE OF codebook_code, archived ON units; SECURITY DEFINER, as a foreign key's own cascade bypasses RLS, so a scope writer who also holds Viewer or Auditor — whom the assets UPDATE overlay refuses — still moves the projection with the mapping; it re-checks the scope writer tier itself and writes only `assets.unit_id`): a code set, cleared, moved or released by an archive moves the equipment projected from it to the code's holder now (none), and the new code fills its equipment that has no unit. A deleted unit is already covered by `assets.unit_id`'s ON DELETE SET NULL. The decode's own fill now goes THROUGH the trigger: it re-sends the planned filing (`{ unit_code }`, guarded `.is("unit_id", null).eq("unit_code", <filing>)`) and the database fills by the mapping at the write, so a remap between the decode's read and its write lands the code's new holder (or none) and is counted `changed`, never the planned unit. (h) **The graph's disagreement note** counted a document (or equipment item) whose operational unit is merely unmapped, or not on the map, as "differ" — thousands of phantom mis-filings right after the apply, while the decode's report said 0 disagree and N "cannot be compared"; `assembleOrgGraph` now counts a disagreement only when the operational unit is mapped to another code, and the unmapped ones apart with their own note. (i) **The scope page's unit list is read whole** (`listCodebookUnits`, keyset pages): it built its picker, its labels and "X of Y mapped" from `loadCodebook`'s one request, cut at 1,000 entries of every kind; an unreadable list is said on the page.
- Fourth review fixes (2026-10-01). (j) **Releasing a mapped unit's code is confirmed as what it does.** Archiving a unit releases its Site Codebook code (the guard) and takes the unit off every item filed under that code that points at it (`trg_units_codebook_code_follow`), yet `/admin/scope` asked "Archive this scope node? Documents and equipment that reference it keep their data" — the opposite of what happens — and restoring the unit does not bring the mapping back. A mapped unit's archive now has its own confirmation (`lib/operationalGraph.ts` `codebookReleaseConfirm`): it names the codebook unit, says how many equipment items filed under the code point at the unit and lose it (`countProjectedEquipment`, a head count of `unit_id` = the unit AND `unit_code` = the code; "could not be read" when it fails, never "none"), that they stay filed under the code, and that restoring the unit does not restore the mapping. An unmap or a remap from the mapping control is confirmed the same way (a remap also says the new code's empty equipment takes the unit); an unmapped unit, a plant and a system keep the plain confirmation. (k) **The panel's promise is exact**: "a unit already set by hand is never changed" became "a unit set by hand that disagrees with the filing is never changed; one that matches the filing cannot be told from the mapping's and follows the filing and the mapping like it". (l) **20261138** revokes EXECUTE on `units_codebook_code_follow()` from PUBLIC, anon and authenticated (DRLS-16: every SECURITY DEFINER function this paste creates is now revoked from anon; PostgreSQL checks no EXECUTE privilege when a trigger fires, so the trigger is unchanged) and probes it, and its pre-apply inventory gains the row that counts who gains the widening of 7. — active members holding a scope writer role (Admin, Manager, Supervisor, DocCtrl) together with Viewer or Auditor, from `role` and `roles`. (m) **The route reads to an empty window.** `readAll` stopped at the first window shorter than 1,000 rows; with PostgREST's max-rows set lower, the decode planned over a cut set of documents, equipment, units and codebook units and reported it whole. Every route read now pages (keyset over `id`) until an empty window. The non-decoding sample list on the panel is keyed by position as well as number (a multi-sheet set shares one number).
- `/admin/scope`: each operational unit is mapped to the codebook unit it is (`UnitMapping` → `setUnitCodebookCode`, a checked write; a code mapped elsewhere is refused by name), and the Unit identity panel previews and runs the decode, listing the numbers that do not decode with the codebook's own reason (`explainDrawingNumberMiss`).
- `lib/orgGraph.ts` emits one node per real unit: a mapped operational unit IS `cbunit:<code>`; an unmapped one is `unit:<uuid>`; `documents.unit_code` is drawn.

Tests: `lib/__tests__/orgGraph.test.ts` (one node, 2 hops, the guard test "each edge is a row somewhere" — a decodable number with no unit_code row draws no unit edge, and `lib/orgGraph.ts` never calls the decoder), `lib/__tests__/intelRoundGUnitIdentity.test.ts` (planner, route, mapping write, migration shape; review fix: a Supervisor caller never sees a private non-decoding number and a DocCtrl does; a first apply keeps a hand-set assets.unit_id on a mapped unit; a 4,150-document apply continues across two calls with an audit row before and after each; no writes when the opening audit fails; the panel loop stops on refusals and reports an interrupted call; the mapping guard's shape and role list; the mapping's read-back). The review-fix cases fail against the first cut (20 of them on the code, 2 on the migration). Second review fix: a Supervisor sets an asset's unit and a drawing is renumbered between the decode's read and its first write — the hand-set unit is kept, the renumbered drawing is not stamped, both are counted `changed`, and the next run decodes the new number; a 1,100-entry codebook with unit 70 past row 1,000 keeps the unit-70 decodes; an unreadable unit list plans nothing; `listCodebookMappings` names a unit under an archived plant. Against the previous branch head with the max-rows stand-in, these 6 cases fail (e.g. `expected 'u20' to be 'u30'`). Third review fix: after a decode, a refile through `updateAsset` moves the item to its new unit in `searchAssets({ unitId })` while a hand-set unit is kept; a remap through `setUnitCodebookCode` (release, then the replacement takes the code, then an archive) moves the projected equipment each time; `createAsset` lands with its unit; a remap between the decode's read and its write leaves the item empty (counted `changed`) until the new holder takes the code; an unmapped operational unit is "cannot be compared" on the graph, never "differ"; `listCodebookUnits` reads a 1,100-entry codebook whole; the two projection triggers' shape (rule order, roles pinned to `ADMIN_SURFACES`, writes only `assets.unit_id`) and probes. The scenario cases run against stand-ins transcribed rule for rule from the triggers; against the previous branch head 7 cases fail (the graph note, the route's remap-at-write and its patch shape, `listCodebookUnits`, the header and both trigger shapes). Fourth review fix: `countProjectedEquipment` counts only items that point at the unit AND are filed under the code (an item set by hand to the unit but filed elsewhere is not counted; another org's is not; an unreadable count is null); `codebookReleaseConfirm`'s archive / unmap / remap copy (the count, singular and zero, an unknown count never read as none, restoring does not restore the mapping, never "keep their data"); the scope page uses it for a mapped unit and keeps the plain copy otherwise, the panel's reworded promise, the sample keys; with max-rows set to 3 the route still reads 7 documents, 5 items, 4 units and 4 codebook units and writes them all; the revoke, its probe, and every SECURITY DEFINER function in the file revoked from anon; the widening-population inventory row (9 rows, roles pinned to `ADMIN_SURFACES`). Against the previous branch head 4 of these fail in this file (the route's max-rows case, the page, the inventory count, the revoke) and the two lib functions do not exist. Verified on a scratch PostgreSQL 16 with stubbed auth: the paste ran in one go with every probe true and the inventory rows filled; the service role's decode write landed; a person's write was refused with `documents_unit_code_decode_only`, a person's insert landed NULL, a person's title edit kept the decode, a renumber (person or service role) dropped it while a renumber that set a new decode kept it; a second units row mapped to the same code was refused by `units_org_codebook_code_uniq`; `documents_total_for_org` answered the member 3, a non-member 0, and anon `permission denied`; a re-paste was clean. The review fix's paste was run the same way (scratch PostgreSQL 16.13, stubbed auth and `caller_holds_any_role` as in 20261045): every probe true, including the new mapping-guard probe; a Viewer's map, unmap, archive of a mapped unit, insert-with-a-code and delete of a mapped unit were each refused with `units_codebook_code_scope_writers`; a Viewer's rename (mapping untouched), archive or delete of an unmapped unit and plain insert landed; an Admin's delete of a mapped unit landed; a Supervisor held additively under a Viewer headline mapped a unit; an Admin's archive released the code and the code then mapped to another unit; mapping an archived unit landed NULL; the service role remapped; the re-paste was clean and its new row counted the one asset whose unit_id differs from the unit its filing maps to. The third review fix's paste was run the same way (scratch PostgreSQL 16.13; stubbed auth; `caller_holds_any_role`, `caller_is_active_member`, `assets_guard_registry` and the assets / units policies as in 20261045 / 20260606), every probe true, including the two new ones: an Admin's mapping filled the equipment filed under the code with no unit and kept a hand-set disagreement and an unfiled item's unit; a refile of a projected item moved its unit to the new filing's holder, while a refile of a hand-set unit (to no filing, or another) kept it; a new item took its filing's unit and one inserted naming its unit kept it; a remap (release, then take by the replacement) cleared and then refilled the projected item; an archive released the code and cleared its projection; a Viewer's map was refused by `units_codebook_code_scope_writers`; a Supervisor held under a Viewer headline — refused a direct asset write by the overlay (0 rows) — mapped a unit and its equipment followed; the decode's fill write (service role) after a remap landed NULL rather than the planned unit, and filled once the new holder took the code; a refile that named a different unit in the same write kept it; an Operations member's whiteboard flip landed and their refile was refused by the registry guard; deleting a mapped unit cleared its equipment (ON DELETE SET NULL); the re-paste was clean. The fourth review fix's paste was run the same way (scratch PostgreSQL 16.13; stubbed auth, roles `anon` / `authenticated` / `service_role` with Supabase's default function grants, `caller_holds_any_role` / `caller_is_active_member` and the assets / units policies as in 20261045 / 20260606): every probe true, including the new revoke probe; the new inventory row counted the two active members holding a scope writer role with Viewer or Auditor and not an inactive one; with EXECUTE revoked, a Supervisor held under a Viewer headline mapped a unit and its equipment filled, archived it and the equipment was cleared and the code released, and a Supervisor's restore left the unit unmapped until it was mapped again (the equipment then refilled); calling `units_codebook_code_follow()` by name as `authenticated` or `anon` was refused `permission denied`; a plain Viewer's unmap was refused by `units_codebook_code_scope_writers`; the re-paste was clean.

**Pending migration:** `supabase/migrations/20261138_intel_roundG_unit_identity.sql` (hand-applied). DEC-30: the decode runs in TypeScript after the apply, so the disagreement inventory is 0 on the first paste; **re-paste the file after the first decode run** (it is idempotent) and its last two rows report the real counts — documents whose operational unit is mapped to a different codebook unit than their decode, and decoded documents whose operational unit is not mapped:
`SELECT COUNT(*) FROM documents d JOIN units u ON u.id = d.unit_id WHERE d.unit_code IS NOT NULL AND u.codebook_code IS NOT NULL AND u.codebook_code <> d.unit_code;` and the same with `u.codebook_code IS NULL`. Both are reported, never rewritten. A third after-row counts the assets whose `unit_id` differs from the operational unit their filing maps to (kept — a unit set by hand or by an import; a projected unit follows its filing and the mapping).

**Done-when (acceptance).**
1. ✓ A codebook unit code resolves to at most one `units` row (UNIQUE per org), and the mapping is data (a column set on /admin/scope).
2. ✓ `documents.unit_code` exists and is written by the decode (the unit-identity backfill).
3. ✓ The graph emits one unit node per real unit (given the mapping a person sets — an unmapped operational unit is a different unit).
4. ✓ A number that does not decode, decodes with no unit segment, or names a unit the codebook does not hold is reported (count, sample numbers, the codebook's reason; the unknown codes with counts) and left empty — never guessed.

**Scope / residual.** Freshness: equipment is current without a run — the database projects `assets.unit_id` on every insert, refile and mapping change (third review fix); a unit set by hand that disagrees with the filing is kept and counted, and since the column records no provenance, one that equals the old filing's projection is treated as the projection: it moves on a refile, and it is cleared when its unit's code is released (unmapped, remapped or archived — the release confirmation counts it among the items that lose the unit). A document created or renumbered after a run has no decode until the next run; the create-time decode belongs with the writers that already decode (I-11's Bridge at ingest; document-control's `lib/documentLifecycle`) — tracked as [`GAP-314`](#gap-314) (integration, 2026-10-01). `lib/schemaExpectations.ts` (A&O's) may list `documents.unit_code` / `units.codebook_code` in the health panel when it is next regenerated (ILIFE-12 / BKP-14). The decode's READ phase is not bounded per call (each call re-reads every document and equipment item before its bounded writes; only the writes are bounded within the function's 60 s) and the panel captures its access token once for the whole loop — fine for the org sizes in view, worth bounding when a site's register passes ~100,000 rows. The route's reads page to an empty window, so they hold under any max-rows; the scope page's `listCodebookUnits` and `listCodebookMappings` page through `lib/orgGraph.ts` `pageRows`, which stops at a short window and so assumes max-rows of at least 1,000 (PostgREST's default) — the graph's own reads share that assumption (GM-3's residual). Not closed here (DEC-31): the operational tables themselves (`plants`, `units`, `systems`) are still `FOR ALL` to any active member (`*_member_all`, 20260606), so a member outside the scope writer tier can still rename a unit or archive / delete an UNMAPPED one through the API; the mapping is guarded, the rows around it are not.

---

<a id="gap-306"></a>
## GAP-306 · `lib/scope.ts` — a scope is a resolved id set

**Verdict: BUILD** · Effort: **L** · Depends on: `GAP-305` · **His headline ask**

> *"I can't do extreme pivot views like ok crude unit, all this goes here."*

### Two corrections to the obvious approach

**1. Scope is containment, not hops.** Focus mode is BFS from a node; at depth 3
it pulls in every document touching the unit's assets and every other unit
sharing them. Containment answers "belongs to", which is what he said.

**2. It must scope the ASSEMBLY, not the assembled graph.** `DOC_CAP 1500` /
`ASSET_CAP 2000` / `EDGE_CAP 8000` are applied during assembly. Filter after and
the caps have already thrown away the unit's tail — **the filtered view silently
lies**, and it lies worse the bigger the plant.

**3. It is not a graph feature.** A scope resolved once — as a set of document,
asset and unit ids — serves the graph, the registry, the knowledge binding and
the flows panel. Build `lib/scope.ts` once; let four surfaces consume it.

That reframes his complaint: he experienced it as a graph shortcoming because the
graph is where he went looking. **The operating area is arguably the better first
delivery** — the same scope, as a *place* you stand in rather than a filter you
apply. Argue it on his behalf before building the filter.

### Do not

- **Do not implement scope as `hiddenTypes` with more entries.**
- **Do not filter post-assembly.**
- **Do not hide boundary-crossing edges silently.** Draw a stub — "3 more this
  way" — or the map lies by omission.
- **Do not name the lenses after what they hide.** That is the naming defect:
  "Process" means "everything except paper". Name them for what is shown, and
  resolve the collision where asset nodes are labelled "Equipment" *and* a lens
  is called "Equipment ↔ Docs".

### Acceptance

1. Picking a unit yields that unit's world and nothing else, with boundary stubs.
2. The same scope object drives at least two surfaces.
3. A scope is nameable, savable and shareable by URL.
4. Scoped assembly returns complete results within the caps for a unit that
   exceeds them org-wide.

**Partial (2026-10-01, intelligence Round G, I-13).** The core ships; the picker and the operating-area link follow, as the plan sequences them. Decision on "argue the place before the filter" (the plan's default — `DEC-67`): `lib/scope.ts` is consumed FIRST by the operating-area page (I-09 AREA-6, linking `/graph?scope=unit:<code>`), THEN by the graph's scope picker (I-14) — the place is the first delivery, the filter the second. What landed:
- `lib/scope.ts` — `resolveScope(orgId, { kind: "unit", code })` resolves CONTAINMENT under the reader's RLS, from persisted rows only: the codebook unit, its mapped operational unit, systems and plant; equipment filed to it (unit_code, unit_id, system_id); documents decoded to it (documents.unit_code), filed to it (unit_id / system_id), in its pinned libraries and folder subtrees, and governing its equipment one step (document_assets, entity_mentions through knowledge mirrors) — never further. Every rule is paged to completion up to `RESOLVE_CAP`; a failed read or a reached cap marks the scope incomplete and says which rule. `scopeMembership` tests node ids; `parseScopeParam` / `formatScopeParam` define the URL key `unit:<code>`.
- `lib/orgGraph.ts` `buildOrgGraph(orgId, { scope })` scopes the ASSEMBLY: it reads the unit's ids (not an org-wide capped slice), applies the caps to the unit's own population, makes nodes only for members, and counts every link that leaves the scope on the node it leaves from (`GraphNode.outside`, `OrgGraph.scope.boundary`, a truncation "N links lead out of Crude Unit — each node shows how many leave from it."). Documents the relation names but the reader cannot open are said, not drawn.

Tests: `lib/__tests__/scope.test.ts` — containment by every rule and nothing one step past; a mention through an indexed copy; a failed read marks the scope incomplete; pre-migration absence said; and the acceptance case below.

**Done-when (acceptance).**
1. Partly — the lib half ✓: a unit's scope yields that unit's world and nothing else, with boundary stubs (no unit-30 node on Crude Unit's map; the drawing tagged to a unit-30 exchanger and the pump feeding one each carry `outside: 1`). **Not met here:** "picking" — the picker is I-14's (the page and components/graph/*).
2. Partly — one surface consumes the scope object today (the org graph's assembly). **Not met here:** the second — the operating-area panel (UnitOpsPanels, I-09 AREA-6) is its planned next consumer.
3. **Not met here:** nameable / savable / shareable by URL — the key exists (`unit:<code>`); the URL contract and saved lenses are I-14's (GPV-11).
4. ✓ `scope.test.ts`: a unit whose 50 assets sort past the org-wide asset cap and whose 40 documents are older than the org-wide document cap is absent from the org-wide map and complete on its own (50 assets, 40 documents, no cap notice).

**Scope / residual.** I-09 AREA-6 (the place), then I-14 (the picker, the URL, saved scopes). Both read `lib/scope.ts`; neither needs a change here. The mapping and the decode (GAP-305) must be applied and run for the decoded / filed rules to find anything.

*Landed 2026-10-01 (intelligence Round G, I-09 — the operating-area limb, `AREA-6`).* The operating area consumes the scope through its URL key. `components/assets/UnitOpsPanels.tsx` `unitGraphHref(code)` builds `/graph?scope=<formatScopeParam({ kind: "unit", code })>&focus=cbunit:<code>`. The unit hub's FlowPanel and the area panel's header carry it: the place is the first delivery (DEC-67 item 6). FlowPanel's own flow list keeps the area's filing set (`assets.unit_code`, every page), not `resolveScope`, whose document rules a flow list does not need. Acceptance 2 holds once the graph page reads `?scope=` (I-14); acceptance 1 (the picker) and 3 (saved, nameable scopes) stay I-14's.

**Resolution (2026-10-02, intelligence Round G).** The remaining acceptance limbs:
- **Picking.** The graph's scope picker (top bar `select`, `app/(protected)/graph/page.tsx:895`; a Site Codebook unit's peek, "Scope the map to this unit") sets `GraphSettings.scope` and assembles that unit's world through `buildOrgGraph(orgId, { scope })`. Boundary stubs are now DRAWN: a dashed stub with "+N" on the node in 2D, "+N out" on its label in 3D, and "N links lead out of <unit> — not drawn here" in its peek.
- **The URL key.** The graph reads the operating area's link (`?scope=unit:<code>&focus=cbunit:<code>`, `UnitOpsPanels.unitGraphHref`, I-09 AREA-6) through the same key (`parseScopeParam`).
- **Named and shared.** A scope is nameable and savable — a saved view carries the scope with the filter and depth (`GraphSettings.savedViews`) — and shareable by URL (`scope=`, "Copy a link to this view").

**Done-when (acceptance).**
1. ✓ Picking a unit yields that unit's world and nothing else, with boundary stubs (the lib half by I-13; the picker and the drawn stubs here). `graphPageRender.test.ts` "picking a unit in the top bar assembles that unit's world; the chip clears it".
2. ✓ The same scope object drives two surfaces. The operating area (I-09) links the scope by its key, the graph (here) reads it and assembles by `lib/scope.ts`. `graphPageRender.test.ts` "the operating area's ?scope=… assembles that unit and opens it".
3. ✓ A scope is nameable, savable and shareable by URL (`graphSettingsUrl.test.ts` saved-view round trip; the URL round trip).
4. ✓ (I-13) Scoped assembly is complete within the caps.

**Scope / residual.** The mapping and the decode (`GAP-305`, `20261138` — Pending in `audit-reports/MIGRATION-PASTE-ORDER.md`) must be applied and run for the decoded and filed rules to find anything. Until then a scope holds the codebook filing and the pins.

---

<a id="gap-307"></a>
## GAP-307 · Any door

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-304`

> *"If I give the system **at any point** from the knowledge or the operating
> areas…"* · *"when I get any P&IDs **no matter where it comes from**…"*

He said it twice. He has already been bitten by doors that only work from one
screen, and it is worse than he knows:

```ts
// lib/equipmentBridgeServer.ts:56
if (!kdoc?.source_document_id) return null;
```

A P&ID uploaded straight into a knowledge library indexes, is askable, shows in
the census — **and builds nothing.**

And the master-list door is narrower than it looks. `lib/xlsxData.ts`
`parseWorkbook` **is in production** — wired only to the templates feature. The
asset importer is paste-only CSV with `CANONICAL_FIELDS = [tag, description,
location, type]` — **no unit, no code**. So the spreadsheet lands undecodeable,
which is the one thing his codebook exists to prevent.

### Scope

**In:** one pipeline that accepts a master list (CSV/XLSX) or a drawing set, from
any door, and drives the same reconcile. The `source_document_id` gate moves from
"may this run at all" to "is there a column to populate".

### Do not

- **Do not build a second extraction engine.** This is a wiring problem.
- **Do not let the doors diverge in provenance.** Which door it came through is
  part of the record (`GAP-303`).

### Acceptance

1. A P&ID uploaded to a knowledge library builds the registry.
2. An XLSX master list imports with unit and code, decoded by the codebook.
3. All doors produce the same relation shape and distinguishable provenance.

**Partial (2026-10-02, intelligence Round G, I-11).** The `source_document_id` gate moved from "may this run at all" to "is there a controlled document to relate to and a column to populate". A controlled P&ID builds the registry and the relation with or without a column (AREA-4). A P&ID uploaded straight into a knowledge library is reported as `upload_origin` (BR-3) and listed by the coverage report ("On a sheet, in no list", door `knowledge`). From there a writer picks its tags and Discover creates them (`discoverFromKnowledge`): origin 'drawing'; `discovered_from: { knowledgeDocumentId, pages, door: "knowledge" }`; unit-less, because there is no decodable number, and said; audited as `EQUIPMENT_BRIDGE_DISCOVERED`. It is a person's pick, never automatic (DEC-96 item 3). No second extraction engine: both doors read the same `knowledge_page_entities`.

**Done-when (acceptance).**
1. ✓ A P&ID uploaded to a knowledge library builds the registry through the knowledge door (`lib/__tests__/equipmentBridge.test.ts` "named tags on the document become discovered assets with door 'knowledge' provenance; an existing one is counted").
2. ✓ By `BR-4` (resolved 2026-09-30): the master-list importer reads XLSX (`/api/assets/parse-workbook` → `lib/xlsxData.ts`) and files each row's unit and code through the codebook (`planAssetImport`).
3. ◐ Distinguishable provenance ✓: `discovered_from.door` names the door, the controlled door's link is `source 'drawing'` with its sheet and revision, and the master list's rows are `origin 'manual'`. The same relation shape ✗ for the knowledge door: `document_assets.document_id` references a controlled document, and an upload has none. Its link appears once the drawing is filed in Document Control and swept.

**Scope / residual.** Whether a knowledge upload gets a relation row of its own (a nullable `document_id` plus a `knowledge_document_id`, or a second table) is a schema decision left open. Until then the coverage report keeps the upload's sheets as a working list.

**Assigned (2026-10-13, integrator, I-11 merge, DEC-31).** intelligence I-26 BRIDGE REMAINDERS (acceptance 3: a relation for knowledge uploads; the integrator's default shape is a second table, `knowledge_document_assets`, so `document_assets.document_id` keeps its FK).

**Fix pass 2 (2026-10-02, review).** The knowledge door's `EQUIPMENT_BRIDGE_DISCOVERED` audit insert was fire-and-forget, though this record says the door is audited. It is checked now: a refused insert returns `auditError` with the discovery's result, and the coverage report shows it after its re-derive. Tests: `lib/__tests__/equipmentBridge.test.ts` "the apply's audit row and the knowledge door's are checked: a refused insert is said to the caller"; `lib/__tests__/coverageReportRender.test.ts` "a discovery that landed but whose audit row was refused is said (GAP-307 / GAP-303), not swallowed".

**Resolution (2026-10-20, intelligence Round G).** Package I-26 BRIDGE REMAINDERS, acceptance 3. The schema decision was the integrator's default (DEC-96, landed line): a second table, so `document_assets.document_id` keeps its FK to a controlled document. `supabase/migrations/20261235_intel_roundG_knowledge_document_assets.sql` (DEC-30 one paste: a counts-only inventory before `BEGIN`, one final `SELECT (check, ok, n)`) creates `knowledge_document_assets` — the same relation shape as `document_assets` for a knowledge upload: `org_id`, `knowledge_document_id` (FK, CASCADE), `asset_id` (FK, CASCADE), `tag_text`, `source` (`'drawing'` only), `sheet_label`, `pages`, `asserted_by` (`machine` | `human`), `asserted_by_user`, `model`, `source_revision`, `source_version_id`, `created_at`, `updated_at`; one row per (upload, asset) (`knowledge_document_assets_pair_uniq`); a 'drawing' row is a machine's (CHECK). A same-org trigger (plain `plpgsql`, `search_path` pinned, not SECURITY DEFINER, EXECUTE revoked from PUBLIC / anon / authenticated) refuses an upload or an asset of another workspace (23503) and stamps `updated_at`. RLS: a signed-in member reads a row of their workspace only while they can read its upload (a RESTRICTIVE `EXISTS` on `knowledge_documents` under their RLS — DACL-11's rail, so a private mirror's links stay private); no signed-in write path at all (INSERT / UPDATE / DELETE revoked from `authenticated`); anon nothing; the service role (the Bridge) writes.
- **The writer.** `discoverFromKnowledge` (`lib/equipmentBridgeServer.ts`) — the knowledge door, a person's pick (DEC-96 item 3, unchanged) — now relates each picked tag's asset, created or already in the registry (including one raced into existence, 23505), to the upload: the pages it was read on, the title block's sheet address for them (GAP-301, marked AI-read when an AI model transcribed the page — GOV-9) and the transcribing model, as an upsert on the pair. A relation that cannot be written never fails the discovery: before 20261235 the result says `KNOWLEDGE_RELATION_NEEDS_MIGRATION` — "The equipment was discovered; which sheets of the upload carry it is recorded once migration 20261235 (knowledge_document_assets) is applied — discover again after it to record them." — and only on a missing TABLE (42P01 / PGRST205; a missing column, 42703 / PGRST204 or the INSERT-shaped "column … of relation … does not exist", is the real error, review fix pass); any other failure "could not be recorded: …"; the audit row counts `relationsWritten` / `relationNotRecorded`.
- **The reader.** The coverage report (`lib/bridgeCoverage.ts`, `components/assets/CoverageReport.tsx`) reads the upload's links (service role, only counted uploads, never mirrors) and lists a linked pair's sheets as relation rows (door `knowledge`, shown "knowledge upload · linked") instead of the tags read off it; a table that does not exist yet (42P01 / PGRST205) falls back silently to the working list, any other failure is said.
- Export: `knowledge_document_assets` is listed in `lib/__tests__/exportCoverage.test.ts` `DECISION_AT_MERGE` — proposed EXPORT in `ORG_SCOPED_TABLES` beside `document_assets`, restored after `knowledge_documents` and `assets` (the integrator's call at merge). Schema health: listed in `lib/__tests__/schemaExpectations.test.ts` `ROW_AT_MERGE` (`knowledge_document_assets` → `20261235_intel_roundG_knowledge_document_assets.sql`) for the integrator to add to `lib/schemaExpectations.ts` (not this package's file). *Done by the integrator at the I-26 merge, 2026-10-20 (DEC-90): EXPORTED (`lib/exportTables.ts` `ORG_SCOPED_TABLES`, beside `document_assets`; no bearer-named column), restored after `knowledge_documents` and `assets` (`lib/dataRestore.ts` `RESTORE_TABLE_ORDER`, `RESTORE_PARENT_RULES` for both foreign keys, a `RESTORE_SERVICE_ROLE_WAIVERS` entry), listed in `lib/schemaExpectations.ts` `EXPECTED_TABLES`; both `AT_MERGE` entries removed.*

**Acceptance.**
1. ✓ (2026-10-02).
2. ✓ (by `BR-4`, 2026-09-30).
3. ✓ All doors produce the same relation shape and distinguishable provenance: a controlled drawing's link is a `document_assets` row and a knowledge upload's a `knowledge_document_assets` row, each with its source, sheet, pages, revision, model and `asserted_by`; `discovered_from.door` still names the door. Tests: `lib/__tests__/intelRoundGI26KnowledgeRelation.test.ts` (the writer and the reader, with the regression that a discovery before 20261235 answers as it did plus the sentence); `lib/__tests__/intelRoundGI26Migrations.test.ts` (the DEC-30 shape); on the PostgreSQL 16 harness, `lib/__tests__/rls/intelI26BridgeRemainders.test.ts` — the file replays as one paste; an engineer, Document Control and a Viewer read an upload's row, a mirror's row only while they can open its controlled document (hidden from the Viewer), another workspace's member reads none, anon is refused (42501); no signed-in role inserts, updates or deletes (Document Control included); the service role is refused a cross-workspace upload or asset (23503), a human 'drawing' row (23514) and a duplicate pair (23505), and refreshes its pair by upsert; an upload's deletion cascades; a re-paste is clean and its one result set reads every probe `t`.

*Fix pass (2026-10-20, the integrator's fix pass at the I-26 merge; Ruled by the integrator at the I-26 merge, 2026-10-20 (DEC-90)).* (1) One row per (upload, asset): two spellings of one tag (`P-101A`, `P-101-A`) reach one asset, and an upsert naming the same conflict key twice is refused whole by Postgres ("ON CONFLICT DO UPDATE command cannot affect row a second time"), every other tag of the batch with it. `relateKnowledgeUpload` (`lib/equipmentBridgeServer.ts`) now merges the batch by asset before the upsert — the pages united, the first spelling kept as `tag_text`. Today the knowledge door's extractor gate turns `P-101-A` away, so the merge is defensive; it holds whatever reaches it. Tests: `lib/__tests__/intelRoundGI26KnowledgeRelation.test.ts` "REGRESSION (review): one row per (upload, asset) …" (the two spellings → one upserted row, pages [3, 4], every other tag written — fails on the pre-fix file; and the same batch through the door). (2) The paste facts restated, one sentence everywhere: `20261235` requires `20260609` (assets), `20260911` (knowledge_documents), `20260917` (knowledge_documents.source_document_id) and `20260928` (assets.origin / discovered_from); paste it any time after those — after `20261170` / `20261171` is advisory only. Header only; the SQL body is unchanged and the PostgreSQL 16 harness file passes (7).

**Scope / residual.** Pending migration: `20261235`, a narrow widening (a new table, readable by members under the upload's own read rail; no existing read or write changes). Requires `20260609` (assets), `20260911` (knowledge_documents), `20260917` (knowledge_documents.source_document_id), `20260928` (assets.origin / discovered_from). Paste order: any time after those four — after `20261170` / `20261171` (whose shape it mirrors) is advisory only; it depends on neither in SQL. Deploy order: either — before the paste the discovery records nothing and says so, the coverage report reads as before. A knowledge upload's links are written only by a person's Discover pick (DEC-96 item 3); nothing writes them automatically.

---

<a id="gap-308"></a>
## GAP-308 · The coverage report

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-307`

> **Why he did not ask:** he is picturing the import as an event that works or
> does not. He has never had a system that could do it at all, so he has no
> experience of the state that follows — a mostly-right 400-row register whose
> wrongness is invisible.

Four questions, the morning after: **what agrees, what is in the master list but
on no sheet, what is on a sheet but in no list, what disagrees.**

That report is simultaneously the answer to *"how do I know it worked"* and his
to-do list. It also makes "partially" a legitimate visible state — which is what
he was apologising for when he said *"so I can do partially and at least make the
assets in the right category."* **He should not have to apologise for it. It is
the correct intermediate state and the system should hold it honestly.**

### Acceptance

1. Per unit and org-wide: assets total, assets on ≥1 sheet, assets on none, sheet
   tags matching no asset.
2. Each bucket is a working list, not a number.
3. It is re-derivable, not a stored snapshot that drifts.

**Resolution (2026-10-02, intelligence Round G, I-11).** `lib/bridgeCoverage.ts` `buildCoverage` (pure) and `loadCoverage` (reads, keyset-paged to a 50,000-row ceiling that is said when reached) produce the four working lists:
- **agree:** an asset on at least one sheet, by relation or by extraction, with where;
- **in the list, on no sheet;**
- **on a sheet, in no list:** with each sheet, page and door, never a `self` row read as a tag;
- **disagree:** the asset's unit against the units of the drawings it is read on.

The totals are assets, on ≥1 sheet, on none, sheet tags matching no asset, and disagreements, org-wide or per unit (the unit's equipment, and the sheet-only tags of drawings decoded to it). A controlled document the caller cannot read, and its copies, never count (`readableControlledDocIds`, fail closed; said: "N documents you cannot read are left out"). Only the current-revision copy counts (GAP-309). Archived equipment is not listed. The report is re-derived from the rows on every read; no snapshot is stored.

`components/assets/CoverageReport.tsx` renders the tabs and the unit selector, and lets a writer Discover sheet-only tags from knowledge uploads (GAP-307). It is opened in two places (`POST action "coverage"`, the registry writer tier): org-wide from the equipment sweep, and scoped to the unit from an operating unit's page (`/admin/assets?unit=…`, "Coverage — drawings vs. the equipment list", opened on demand). The selector still widens the unit view to org-wide.

**Done-when (acceptance).**
1. ✓ Per unit and org-wide: assets total, on ≥1 sheet, on none, sheet tags matching no asset (`lib/__tests__/bridgeCoverage.test.ts` "org-wide: totals and every bucket is a list of rows to act on", "per unit: …").
2. ✓ Each bucket is a working list, not a number.
3. ✓ It is re-derivable ("is re-derived — the same rows give the same report; a new relation moves an asset from list-only to agree").

Placement: `lib/__tests__/coverageReportRender.test.ts` (opened with the unit it asks for that unit, and the selector widens it; the sweep's mount opens org-wide; the unit page mounts it for the writer tier).

**Scope / residual.** Placement is the fleet plan's default (DEC-96 item 5): per unit on the Operating Areas page, org-wide from the sweep. Tags on knowledge uploads have no decoded unit and are listed org-wide only (said).

---

<a id="gap-309"></a>
## GAP-309 · Revision truth — notice when a tag leaves a sheet

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-301`, `GAP-303`

> **Why he did not ask:** the Bridge only ever *adds*. Every sweep he has run
> made the registry bigger. A registry never shrinks on its own, so the loss is
> invisible by construction — nothing on any screen says *"this tag used to be
> here."*

Rev 3 deletes a vessel. The equipment list keeps claiming it. **In a PSM shop a
false record is worse than an empty one, because people stop checking the paper.**

Related and confirmed: rev-up refresh deletes chunks but never
`knowledge_page_entities` (`ING-*`), so tags from superseded revisions survive
and keep feeding the census, the Bridge and asset discovery.

### Do not

- **Do not auto-remove on absence.** An extraction miss and a real deletion look
  identical. Surface the delta for review.
- **Do not treat this as a cleanup job.** It is a signal.

### Acceptance

1. Re-extraction after a rev-up produces a reviewable delta: appeared, vanished.
2. Superseded-revision entities do not feed current-state surfaces.
3. A derived fact displays the revision it was read from, and marks itself when
   that revision is no longer current.

**Resolution (2026-10-02, intelligence Round G, I-11).**
- **Only current copies feed the proposal.** A knowledge copy feeds the proposal only when it is ready and at the controlled document's current version (`source_version_id = current_version_id`). A copy at an earlier revision, or one still re-indexing after a rev-up, is recorded in `sources` with why, and never fed. `ING-3` (resolved) deletes a refreshed copy's entities, so a superseded revision's tags are gone at the source too.
- **Marking.** On a complete reading (no slab at its ceiling, no page waiting on AI vision, drawing entities present), each 'drawing' relation whose tag the current revision no longer shows is marked `vanished_at`, and un-marked if the tag comes back. A row read from an earlier revision is marked `superseded_at` until the next refresh. Nothing is deleted on absence: an extraction miss and a real deletion look identical.
- **Review.** The sweep lists vanished links per document for review. "It left the sheet" removes the link (service role), drops the tag from `applied` (a later return is proposed, not silently re-linked) and audits what was removed. "It is still there" clears the mark. Both are audited.
- **Display.** The asset hub shows each link's revision and marks "not on current rev" / "earlier rev"; the sweep shows the superseded note.

**Done-when (acceptance).**
1. ✓ Re-extraction after a rev-up produces a reviewable delta. Vanished links are marked for review; tags that appeared come back as new proposals. `lib/__tests__/equipmentBridge.test.ts` "rev C no longer shows P-7: its relation is marked vanished (kept), the others refreshed to rev C", "an incomplete reading (pages waiting on AI vision) never marks anything vanished", "review: 'it left the sheet' removes the link and records it …; 'it is still there' clears the mark".
2. ✓ Superseded-revision entities do not feed the Bridge, the coverage report or the hub's not-yet-linked sheets ("GAP-309: a copy at an earlier revision than its document never feeds the proposal"; `bridgeCoverage.test.ts` "only the current copy of a readable document and knowledge uploads count"), and the knowledge side deletes them on refresh (`ING-3`).
3. ✓ A derived fact displays the revision it was read from and marks itself when that revision is no longer current (`lib/__tests__/assetHubRelation.test.ts` "a link the current revision no longer carries is marked, not hidden (GAP-309)").

**Scope / residual.** Pending migration: `supabase/migrations/20261171_intel_roundG_provenance.sql`. Before it, revision truth is not recorded and the sweep says so ("20261171 not applied — revision truth is not recorded yet"). Never auto-removed (DEC-96 item 2).

**Fix pass (2026-10-02, review).**
- **A failed window is not a reading.** `computeForDocument` ignored the error of the windowed entity read: a later window that failed left the rows read so far looking complete, so applied tags in the unread windows were marked vanished and the stored proposal shrank. Now an entity-read error throws before anything is written (the stored proposal and every relation stay as they are; the sweep counts the document `failed`; ingest's fire-and-forget catches it), and a failed read of the AI-vision record makes the reading incomplete (nothing marked vanished). The stored proposal is no longer overwritten from an unread ledger either (a ledger read error throws). Each entity window now starts where the rows read so far end, so a window PostgREST cut at max-rows skips nothing. Tests: "a reading whose later window fails is not a reading: …", "a failed read of the AI-vision record makes the reading incomplete: …" (both fail on the pre-fix library).
- **"It is still there" is remembered.** It cleared `vanished_at`, and the next complete recompute of the same revision marked it again — an endless review. 20261171 adds `document_assets.presence_confirmed_on` (UUID): the keep stores the revision (`source_version_id` of the current copy) it was made on, the audit row carries it, and `markRevisionTruth` does not re-mark a row on that revision; a later revision may ask again. Test: "'It is still there' is remembered for the revision it was made on: …".
- **Checked writes.** A mark (vanished / back / superseded) is counted only when its update lands (`failed` counts the rest). "It left the sheet" writes the ledger's `applied` FIRST and throws if it cannot, so nothing is removed whose tag would stay applied and be re-linked silently. Tests: "a mark whose write is refused is not counted (checked writes)", "'It left the sheet' writes the ledger first: …".
- Residual: a document whose copies carry no revision id cannot have its "still there" remembered (nothing to scope it to); the sweep asks again on the next complete reading.

**Fix pass 2 (2026-10-02, review).**
1. The review surface read its rows unpaged. GET's relation read and `markRevisionTruth` are now keyset-paged, and the review actions filter at the database (BR-11's fix pass 2), so a max-rows cut never drops a vanished or superseded mark.
2. `readingOf` fell back to the document's `current_version_id` when no used copy carried a revision id. A legacy copy holding an earlier revision's text therefore stamped its reading as the current revision's, and the superseded mark could never fire for it. The revision is now null (not known) in that case. Test: "a copy that carries no revision id stamps NO revision — never the document's current one" (fails on the fix-pass-1 library).
3. The vanished line marks a sheet read off an AI transcription "(AI-read, unconfirmed)" (GOV-9).

**Fix pass 3 (2026-10-02, review).**
1. **The review list is never hidden by a read error.** GET treated any failure of its full-column 'drawing' relation read as a missing migration. It retried with fewer columns and said "Revision marks need migration 20261171" (or, when that also failed, that 20261170 was not applied) on a database that had both. The vanished-review buttons disappeared, and the person was told the wrong cause. It now falls back only on a missing column (42703 / PGRST204). Any other error is said as what it is ("The drawing links could not be read (…) — the list of links the current revision no longer shows is incomplete …"). Tests in `lib/__tests__/equipmentBridgeRoutes.test.ts`:
   - "GET: a relation read that fails for any reason but a missing column is said as a read failure — never as a missing migration" (fails on the fix-pass-2 route);
   - "GET: a missing column still falls back — …" (the regression guard).
2. **The vanished line.** The line was built in two halves, so a vanished row with no sheet label but a revision rendered "(, read from Rev B)". That is common: every relation written from a page with no title block has a null `sheet_label`. `vanishedWhere` now builds the parenthesis from the parts it has: "(was on SHT 4 (AI-read, unconfirmed), read from Rev B)", "(read from Rev B)", or nothing. Tests: `lib/__tests__/equipmentSweepModalRender.test.ts` "no sheet label, a revision: '(read from Rev B)' — never '(, read from Rev B)'" and "neither sheet nor revision: no parenthesis at all".

---

<a id="gap-310"></a>
## GAP-310 · One tag grammar

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: —

**Four normalizers exist**: `lib/assets.ts:77` (lowercase, strip punctuation →
`e22`), `lib/codebook.ts:112` (uppercase, insert dash → `E-22`),
`lib/documentTags.ts:130`, and a local `assetNorm` at
`lib/equipmentBridgeServer.ts:45`.

They have already broken something: `lib/assetAliases.ts:65` is the **only
writer** of `alias_normalized` and uses the codebook form. Readers split —
`assetAliases.ts:87` and `linkProposerServer.ts:19,279` use the codebook form and
work; **`lib/search.ts:32,55` and `lib/assets.ts:163` use the assets form and are
dead.**

**His semantic alias feature works in the proposer and is dead everywhere a
person types.**

### Do not

- **Do not flip the readers without migrating the column in the same commit.**
  `UPDATE asset_aliases SET alias_normalized = …` ships with the reader change or
  the break inverts.
- **Do not unify by picking whichever is most used.** Pick the one that round-trips
  through the codebook, since the codebook is the identity authority.

### Acceptance

1. One exported normalizer; the other three are re-exports or deleted.
2. Aliases resolve in ⌘K search and on the old-tag URL path.
3. A test asserts every call site agrees on a table of awkward inputs.

**Partial (2026-09-30, intelligence Round G, 99 Phase 0).** The one grammar is the registry's identity key, not the codebook's display spelling: `lib/codebook.ts` exports `tagKey` (lowercase, alphanumerics only) — exactly the database's `normalize_tag()` (20260609) and what `assets.tag_normalized` already holds, so choosing it rewrites no registry key and no trigger. It is the projection of the canonical spelling (`tagKey(normalizeTag(x)) === tagKey(x)`, and `splitTag(tagKey(x))` agrees with `splitTag(x)` wherever the codec places the tag), which is what "round-trips through the codebook" means here; the codebook's `normalizeTag` stays as the display/codec spelling and is documented as NOT an identity key. Picking the codebook spelling instead would have been wrong on the evidence: it is not punctuation-blind (`NORTH-FURNACE` ≠ `NORTHFURNACE`), which the table's own comment (`20260807`: "Same normalization as tags, so matching is punctuation-blind") and `lib/assetAliases.ts`'s promise both rule out. `lib/assets.ts` `normalizeTag` and `lib/documentTags.ts` `normalizeTag` are now `= tagKey` (re-exports, not copies); `lib/pidTrace.ts` keeps its uppercase trace key with a comment that it is a different identity. The column migrates and the readers flip in ONE commit (`2675323`, the Do-not): `addAssetAlias` writes `tagKey(alias)` (and refuses an alias with no key), `resolveAliasToAssetIds` and `lib/search.ts` look up with it, and `20261127_intel_roundG_one_tag_grammar.sql` rewrites every `asset_aliases.alias_normalized` to `normalize_tag(alias)` — collision-safe under the `(asset_id, alias_normalized)` unique index (one row per (asset, key) carries the key; other spellings of the same alias stay inert, never deleted) — and installs a BEFORE INSERT/UPDATE trigger so every future writer (a restore of an older export included) lands in the grammar. *Review fix (2026-09-30):* the trigger now DROPS (RETURN NULL) an insert whose key another row of the same asset already holds. Such a row is a second spelling, and dropping it matches `addAssetAlias` treating 23505 as "already taught". Before, an org restore of an export holding the keyed row and its inert duplicate spelling (or a pre-20261127 backup with two spellings) hit `asset_aliases_unique_idx` and stopped, skipping every later table. The failure was reproduced on a scratch Postgres 16 and the fix verified there: a restore, a re-run and a reversed-order backup all land one row with no error. Tests: `lib/__tests__/codebook.test.ts` ("GAP-310 — the one tag grammar": the awkward-input table), `lib/__tests__/intelRoundGGrammar.test.ts` (round trips, the restore round trip with two spellings, the migration's shape).

**Pending migration:** `supabase/migrations/20261127_intel_roundG_one_tag_grammar.sql` (hand-applied; its result set carries the pre-apply inventory: rows to rewrite, keyless aliases, duplicate spellings).

**Done-when.**
1. Partly. One exported normalizer (`tagKey`) exists, and `lib/assets.ts` and `lib/documentTags.ts` re-export it. `lib/equipmentBridgeServer.ts` `assetNorm` is I-11's file; it is byte-identical today, and the agreement test transcribes it and accepts either the import or the identical body. **Not met:** `lib/linkProposerServer.ts` (I-08, lines ~257-279) still decides "reached via an alias" by comparing `normalizeTag(alias)` with `normalizeTag(tag_text)`. That is the codebook's display spelling (`lib/codebook.ts` `normalizeTag`), which is not punctuation-blind, so "NORTH-FURNACE" and "North Furnace" do not match there. The comparison is self-consistent and reads the raw `alias` column, not `alias_normalized`, so 20261127 does not break it. It is still a second identity grammar at a call site.
2. ✓ Aliases resolve on the old-tag URL path (`getAssetByTag` fallback — proven by test) and in ⌘K (`lookupTag`, GAP-311 — proven by `lib/__tests__/globalSearchTags.test.ts`), and in document search (`searchDocuments` via the alias key).
3. ✓ A test asserts every call site agrees on a table of awkward inputs: codebook, registry, documentTags, the Bridge's copy, the SQL function (transcribed from its only definition, pinned), and the trace key modulo case.

**Scope / residual.** Handed to I-08: switch `lib/linkProposerServer.ts`'s alias comparison (`canonical` / `viaTag` / `aliases.find(...)`) to `tagKey` from `lib/codebook.ts`, and add it to the awkward-input agreement table. Handed to I-11: the Bridge's `assetNorm` becomes an import of `tagKey` (behaviour-neutral). The column is fully in the grammar only after `20261127` is pasted.

**Resolution (2026-10-02, intelligence Round G, I-11).** The two limbs left by the 2026-09-30 partial:
- The Bridge's key is an import: `const assetNorm = (tag: string) => tagKey(tag);`. The local copy is gone. (As first recorded, "the agreement test's 'Bridge's copy' row now reads the import" was not true — `lib/__tests__/codebook.test.ts` still checked a locally transcribed copy; corrected in the fix pass below.)
- `lib/linkProposerServer.ts` decides "reached via an alias" by `tagKey`. It compares `tagKey(l.tag_text)` against `tagKey(canonical)` and finds the alias with `tagKey(a) === viaKey`, so "North Furnace" and "NORTH-FURNACE" are one alias. The codebook's `normalizeTag` stays only as the display spelling the proposal shows.

**Done-when (acceptance).**
1. ✓ One exported normalizer (`tagKey`). `lib/assets.ts` and `lib/documentTags.ts` re-export it; the Bridge and the proposer import it (`lib/__tests__/equipmentBridge.test.ts` "assetNorm is tagKey" and "lib/linkProposerServer.ts decides 'reached via an alias' by tagKey — 'North Furnace' and 'NORTH-FURNACE' are one alias").
2. ✓ (2026-09-30) Aliases resolve in ⌘K and on the old-tag URL path.
3. ✓ (2026-09-30) The awkward-input agreement table; the proposer's comparison now uses the key that table pins.

**Scope / residual.** The column is fully in the grammar only after `supabase/migrations/20261127_intel_roundG_one_tag_grammar.sql` is pasted (unchanged).

**Fix pass (2026-10-02, review).** The awkward-input agreement table now imports both call sites rather than transcribing them: `lib/equipmentBridgeServer.ts` exports `assetNorm`, and `lib/linkProposerServer.ts` exports its alias comparison as `aliasReachedVia(tagText, canonical, aliases)` (the proposer's loop calls it). `lib/__tests__/codebook.test.ts` "every call site agrees on the awkward-input table (acceptance 3)" asserts `bridgeKey(x) === tagKey(x)` for every awkward input and adds a proposer row: an alias is found when the document reached the asset by any spelling sharing its key, never when it reached it by a spelling of the canonical tag, and never on an empty key. A future change to either comparison now fails that table.

---

<a id="gap-311"></a>
## GAP-311 · Tag lookup in ⌘K

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-310`, `GAP-304`

Somebody radios *"FV-2201 is leaking."* He needs the sheet it is on, mid-sentence,
without leaving the screen — **and without an AI call.** Once the relation exists
this is a lookup, not a question.

> **Why he did not ask:** he asked about the Intelligence tab, so he reasons about
> intelligence as a *place*. The command palette is not in that tab and does not
> look like intelligence — it looks like search.

Note `lib/globalSearch.ts:79` sends an asset hit to
`/admin/assets?tag=…` — the admin table, not the asset hub.

### Acceptance

1. Typing a tag returns the asset, its unit, and its sheets, ranked first.
2. No AI call. Sub-second.
3. It resolves aliases and every tag-format variant.

**Partial (2026-09-30, intelligence Round G).** The lookup ships; the sheets arrive with I-11's relation, as 99 Phase 5 and the plan say. `lib/search.ts` `lookupTag(orgId, query)` resolves what someone typed — a tag in any format (the one grammar on `assets.tag_normalized`), an exact site code, or a taught alias (the alias key) — to the asset, its operating area (the codebook unit label) and the documents it appears on (`document_assets`, then `documents` under RLS, so an unreadable drawing does not come back). Indexed equality reads only; no AI call, no text search; archived equipment is not an answer; a one-character or paragraph-length query returns nothing. `lib/globalSearch.ts` runs it beside the other searches and emits its answers FIRST, flagged `exact` — asset (badge Tag / Site code / Alias), its operating area (an asset-kind hit with `facet: "unit"`, linking `/admin/assets?unit=…`), then the drawings — and de-duplicates the fuzzy results against them; every asset hit (exact or fuzzy) now lands on the asset hub `/assets/<tag>` instead of `/admin/assets?tag=`. `components/navigation/GlobalCommandPalette.tsx` renders exact hits above actions and places. Tests: `lib/__tests__/globalSearchTags.test.ts`.

**Done-when (acceptance).**
1. Partly — typing a tag returns the asset and its unit ranked first ✓, and the documents the relation already links ✓; the Bridge-found sheets (and a sheet label such as SHT 4) appear only once I-11's `GAP-301`/`GAP-304` write `document_assets` rows with the sheet address — `lookupTag` already reads that relation, so no change is needed here when they land.
2. ✓ No AI call; indexed equality reads only (pinned by test).
3. ✓ Aliases and every tag-format variant resolve (pinned by test).

**Scope / residual.** Remaining limb: the sheet address, owned by I-11 (`GAP-301`, `GAP-304`). The search page (`app/(protected)/search/page.tsx`) groups the unit hit with Assets — no new hit kind was added, so that page is unchanged.

**Resolution (2026-10-02, intelligence Round G, I-11).** The remaining limb, the sheet. `lookupTag` reads `sheet_label` and `source` from the relation (falling back to the plain link read on a database before 20261170). Each document hit carries `sheetLabel` and `fromDrawing`. ⌘K's drawing subtitle reads "FV-2201 appears on 2002-D-10001 SHT 4 (read from the drawing) · P&ID crude feed", or "appears on this drawing" for a hand link. Still no AI call: indexed equality reads only, as before.

**Done-when (acceptance).**
1. ✓ Typing a tag returns the asset, its unit and its sheets (with the sheet address once the Bridge wrote the relation), ranked first (`lib/__tests__/globalSearchTags.test.ts` "a link the Bridge read off the drawing carries its sheet address into the lookup and the ⌘K subtitle; a hand link stays plain").
2. ✓ (2026-09-30) No AI call. Sub-second.
3. ✓ (2026-09-30) Aliases and every tag-format variant.

**Scope / residual.** Sheet labels appear for drawings the Bridge has related, after 20261170 and a sweep.

---

<a id="gap-312"></a>
## GAP-312 · The drafting request gets an equipment field

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-304`, `GAP-311`

*Assigned: drafting-flow DF-P6 REVIEW-MODEL (with `WIRE-7` criterion 1; 99-fix-sequencing Phase 5 ships it with `GAP-110` / `GAP-111` on the same form) — by the integrator, 2026-10-13 (I-01B merge, DEC-31; fleet plan `audit-reports/fleet-plans/drafting-flow.json`). Prerequisites `GAP-304` and `GAP-311` are built (I-11).*

> **Why he did not ask:** he was auditing the Intelligence tab, so he inspected
> the Intelligence tab. The request form is Document Control furniture he built
> early and stopped seeing.

His governing principle is that waiting on a person is failure. **The most
reliable wait in a drafting manager's day is not approval — it is a request that
arrived too vague to start.** *"Need iso for the line off the crude tower"* costs
a round trip that a tag would have prevented.

An equipment field on the request, resolving through the same relation, means the
request opens showing the P&IDs its equipment appears on — without anyone
searching. That is his *"how helpful can we make this"* question, answered inside
the surface he uses daily.

Cross-references `GAP-110`/`GAP-111` in the drafting-flow area: the same form,
different fields. **Ship them together or the form gets edited twice.**

### Do not

- **Do not make it required.** Same reasoning as the like-in-kind declaration —
  a required field the requester cannot answer is a wall.
- **Do not auto-create a request from a tag.** Suggesting drawings is help;
  creating work is not.

### Acceptance

1. A request can name equipment; the tag resolves to a real asset or is kept as
   free text and flagged.
2. A request with equipment shows the sheets that equipment appears on.
3. Blank never blocks submission.

*Handoff (2026-09-30, intelligence Round G, I-01 phase A): this gap is [`WIRE-7`](./19-wiring.md#wire-7) criterion 1 and is handed to the drafting-flow fleet — **DF-P6 REVIEW-MODEL**, which edits `app/(protected)/requests/new/page.tsx` for `GAP-110` / `GAP-111`, so it ships with them. No drafting-flow package lists it yet; the integrator adds it to DF-P6 (or schedules it directly after). Intelligence prerequisites: `GAP-311` (I-10, merged) and `GAP-304` (I-11).*

---

<a id="gap-313"></a>
## GAP-313 · A server-assembled graph

**Verdict: BUILD** · Effort: **M** · Depends on: a per-caller document ACL on the server (the DOCUMENT ACL BOUNDARY package's chain work) · *Opened 2026-10-01 (intelligence Round G, I-13) as the follow-up of [`GM-12`](./07-graph-model.md#gm-12) (WONTFIX for now).*

The org graph is assembled in the browser on every mount — about fourteen requests for a typical org, up to ~56 at the caps — and the sessionStorage snapshot that hides it is skipped above 2 MB, which is exactly the orgs that need it. A server route could assemble once, page every table to completion, cache per caller, and reach the service-role-only edges the client never can (knowledge_page_entities' sheets — [`GM-14`](./07-graph-model.md#gm-14)).

### Do not

- **Do not move assembly behind `supabaseAdmin` without the per-caller document ACL.** The client read is safe only because documents RLS (`documents_acl_select` → `node_visible`) hides restricted documents and addEdge drops their edges; a service-role assembly must apply the same predicate — and the app-enforced allow lists and role / team denies — per caller, or every member sees every drawing.
- **Do not cache one payload across callers.** The document side of the graph is the reader's own (GM-6).

### Acceptance

1. One route assembles the graph (and a scoped graph — `lib/scope.ts`) under the caller's own document visibility; a test compares a controller's and a granted-nothing member's payloads with the client assembly's for the same org.
2. The page loads one payload, and says when a cached snapshot was skipped.
3. The page comment matches the real request count.

**Resolution (2026-10-20, intelligence Round G).** I-15 GRAPH SERVER ASSEMBLY, under the integrator's DEC-90 ruling for this package (fail-safe, no regression). Reproduced first (DEC-29) on `8224f80`: `app/(protected)/graph/page.tsx:230` assembled the map in the browser (`buildOrgGraph(activeOrgId, …)`), `:248` read the proposals in a second chain (`readPendingProposalPairs`), `:237` dropped a snapshot over 2 MB with a bare `catch {}` and said nothing, `:213` called the reads "a dozen parallel table pulls", and no `/api/graph` route existed. What landed:
- **One route.** `app/api/graph/route.ts` `GET ?orgId[&scope=unit:<code>]` → `{ graph, proposals }`. It authenticates the bearer, loads the caller's principal (`lib/knowledgeAccess` `loadPrincipal`: a non-member 403, an unreadable membership 503 `PRINCIPAL_UNREADABLE`), and runs `lib/orgGraph.ts` `buildOrgGraphForCaller` (`:1326`) inside `lib/serverClientScope` `runWithServerClient(callerScopedClient(req))`. Every read is therefore the CALLER's own (their JWT on the anon key): documents RLS (`documents_acl_select` → `node_visible`), DACL-11's relation rail and every other table's policy decide exactly as they do in the client assembly — the same reads, the same code (`assembleFor`, `:1251`), not a second walk. The service role reads nothing of the map.
- **The per-caller predicate on top.** `readableControlledDocIds(principal, ids)` (`lib/permissions` `canReadNode` — the I-12 predicate) is asked once per assembly about the documents the caller's RLS listed (`gateDocuments`, `:606`). A refused document is not drawn; every link row naming it (relation, project, curated, supersession, mention — through its knowledge mirror too) is dropped before assembly (`withoutRefused`, `:622`), so it is neither drawn nor counted as "a link that leads off the map"; the caller's visible count loses it, so the access line says one more document is outside their access (or, with no `documents_total_for_org`, a sentence names the count). A controller is never refused (the predicate short-circuits the controller tier), so a controller's map IS the client assembly's map for them. A predicate that cannot decide (`DcLandscapeUnreadableError`, a documents read that fails) **fails closed**: 503 `accessUnchecked`, no map, a plain sentence; the page drops the snapshot it painted and says why. Scoped maps go through the same path (`lib/scope.ts` resolves as the caller; `buildOrgGraph`'s `scope` option is unchanged).
- **Never shared.** Nothing is kept between requests; the answer is `Cache-Control: private, no-store`.
- **One payload.** The pending proposal pairs are read in the same request, as the caller (`readPendingProposalPairs` under the bound client — proposed_links RLS, LNK-4); a pair naming a document the predicate refused is dropped. A failed proposal read is said in the payload (GM-7's three answers kept), never a failed map.
- **The page** (`app/(protected)/graph/page.tsx`) loads ONE payload: `lib/orgGraph.ts` `fetchOrgGraph` (`:1355`; `GraphLoadError` carries the route's sentence and `accessUnchecked`) at `:270`. A map too large to keep as a snapshot (`SNAPSHOT_MAX`, `:117`), or one the browser refuses to store, is said (`data-testid="snapshot-skipped"`) and its stale snapshot is removed. The header comment states the real requests: one for the map (the server makes the ~14 / up to ~56 table reads, server to database), plus the mention run state and the scope picker's codebook units.
- **No migration** for the route (it reads nothing new). GM-7's residual index ships beside it (`20261233`, GM-7's record).

Tests:
- `lib/__tests__/intelRoundGGraphServerAssembly.test.ts` (new, 22) — the **payload comparison**: over one in-memory database seen through two readers' RLS, the route's map for a controller deep-equals `buildOrgGraph` for that controller, org-wide and scoped; for a granted-nothing member whose predicate agrees with RLS it deep-equals the client assembly for that member (the restricted drawing absent, as in their browser); where the predicate is stricter than RLS, exactly that document and its links are gone, uncounted, and the access count says one more is outside their access (org-wide and scoped; before 20261138 a sentence says it). Fails closed (503 and no map; 503 principal; 403; 401; 400), a required read failing answers the client assembly's own error, private/no-store, interleaved callers each get their own map, the proposals in the payload with a refused pair dropped. Mutation check: with the predicate not passed to the assembly, five of these cases fail.
- `lib/__tests__/graphPageRender.test.ts` — the stand-in now serves `fetchOrgGraph` and records each load's arguments exactly as the client assembly's were recorded; every existing pin passes unchanged (73). New: one payload carries the map and the proposals; a small map is kept as the snapshot with nothing said; a map too large says so and drops its stale snapshot; a refusing browser is said; a map whose access could not be checked is not drawn, not even the snapshot, and the page says why; any other failed load is said and the snapshot kept; the comment states the real requests.

**Acceptance.**
1. ✓ One route assembles the graph, and a scoped graph, under the caller's own document visibility (their RLS plus `loadPrincipal` + `readableControlledDocIds`); the test compares a controller's and a granted-nothing member's payloads with the client assembly's for the same org.
2. ✓ The page loads one payload (map + proposal pairs), and says when a cached snapshot was skipped (too large, or refused by the browser).
3. ✓ The page comment matches the real request count.

**Scope / residual.**
- Until intelligence I-30 binds read denies at the database (DEC-90 I-12 R2, DACL-12), the app's predicate can refuse a document that `node_visible` still lets a member read; the server map then shows the member less than their browser's client assembly would. That is the ruling's "a granted-nothing member sees only what they may read" (fail-safe), not a regression of a legitimate read.
- Past DOC_CAP, a refused document is not replaced by the next most recent one: the map draws fewer than 1,500 and still says the cap. The capped-link-table notes (`cappedNote`) count the rows the caller's RLS returned, refused ones included — a count of rows they can already read, never an id or title.
- *(Corrected at the fix pass.)* The predicate decides over the documents READ, not every document the caller's RLS lists: org-wide that is the newest DOC_CAP + 1 (1,501), scoped it is the scope's ids. Past that window, and outside a scope, the visible / outside-access counts and the "links lead to … not on this map" (severed) and "N more this way" counts are RLS-only: a document the predicate would refuse but that was never read is still counted as visible (so `outsideAccess` can be low), and a link row naming it is still counted as leading off the map. "A refused document and every link naming it are neither drawn nor counted, and the access line counts it" holds inside the documents read. Asking the predicate over the full id set for the counts is not built (it would read every document's ACL row on each load). The proposals' `total` (a head count under proposed_links RLS) also still counts pairs naming a refused document; only the pairs themselves are dropped.
- The route does not cache, by design (the "Do not": never one payload across callers); a per-caller cache was the gap's motivation, not an acceptance, and is not built. The service-role-only per-sheet index (`knowledge_page_entities`) is still not drawn as edges: a sheet stays on the relation (GM-14's record).
- `buildOrgGraph` (the client entry) stays exported and unchanged in behaviour; nothing in the app calls it from a page any more.
- *(Fix pass.)* The answer is one buffered body, held to `GRAPH_PAYLOAD_BUDGET` (4,000,000 bytes) against the platform's ~4.5 MB cap. A map past it even with the pairs left out is refused with the reason (413) and drawn nowhere; the member is told to scope the map to one unit. Streaming the answer is not built. At the caps this does not happen (2.2 MB, 2.5 MB with long titles, measured below); only a map well past the caps' shape (very long labels on every node) reaches it.

**Fix pass (2026-10-20, intelligence Round G — review of I-15).**
- **The size of the one answer (major).** Reproduced (DEC-29): on synthetic rows at every cap (1,500 documents, 2,000 equipment items, 300 projects, 8,000-row link tables, uuid ids), the plain JSON came to 3,964,843 bytes for the map (3,841 nodes, 23,010 edges) plus 956,075 for 4,000 pairs: 4,920,918, past the platform's ~4.5 MB buffered-response cap (`vercel.json`; the limit `lib/__tests__/transmittalPortalRoute.test.ts` plans around). Now `lib/orgGraph.ts` packs the answer (`packGraphPayload`, `:1380`): an edge names its two ends by their position in `nodes` and its type by its position in `WIRE_EDGE_TYPES`, and a pair is `[document, target, proposer]` (its node ids are `doc:<id>`). Nothing is dropped; `unpackGraphPayload` (`:1398`) gives back exactly the payload packed, and `fetchOrgGraph` (`:1474`) unpacks it, so the page is unchanged. `fitGraphPayload` (`:1440`) holds the body to `GRAPH_PAYLOAD_BUDGET` (`:1362`): past it the proposal pairs are left out and the payload says why (`PAIRS_LEFT_OUT`, shown in the page's existing proposals note); past it even then, `GET /api/graph` answers 413 `tooLarge` with a plain sentence (`graphTooLargeMessage`) and never hands an oversized body to the platform. `GraphLoadError` carries `tooLarge`, and the platform's own bare 413 reads the same; the page shows the sentence in place of the map and clears an earlier snapshot note (`page.tsx:312`). Measured: 2,171,422 bytes at the caps with every pair (2,523,642 with 120-character titles and descriptions, whose plain JSON is 5,273,138).
- **The real predicate in the payload comparison (minor).** `lib/__tests__/intelRoundGGraphRealPredicate.test.ts` (new) runs the route with NOTHING of the predicate stood in: `loadPrincipal` + `readableControlledDocIds` over an in-memory service-role database holding the landscape (an open library, one restricted by a legacy read list, one granted to a team), the map read through the caller's RLS view. A member with no grant loses exactly the two refused documents and every link naming them where RLS lists everything, and gets the client assembly's map, deep-equal, where RLS agrees; a member of the team keeps the team's document (teams carried); HR held beside a headline Engineer keeps the read-listed one (the role collection carried); a controller's payload is the client map and no document row is read for the predicate; an unreadable landscape is 503 with no map.
- **The residual, stated** (above): refusal is decided over the documents read; the counts past them are RLS-only; the proposals' total; the payload ceiling.

Tests (fix pass): `lib/__tests__/intelRoundGGraphPayloadBudget.test.ts` (new, 7: the cap-scale map; the plain payload past the platform's cap — the reproduction; packed within the budget with every pair, and with long text; the round trip exact; pairs left out, then refused; every edge type and field survives); `intelRoundGGraphServerAssembly.test.ts` (+5: the body packed and unpacked to the client map, JSON, private; pairs left out past the budget; 413 `tooLarge` past it alone; `fetchOrgGraph` unpacks a packed answer; a 413, the route's or the platform's bare one, is `tooLarge`; every payload comparison now reads the unpacked answer); `intelRoundGGraphRealPredicate.test.ts` (new, 7); `graphPageRender.test.ts` (+1: a too-large map is said, no map, no snapshot note).

**Acceptance (fix pass).** 1 ✓, now with the answer's size bounded: at the caps the payload is 2.2 MB, under `GRAPH_PAYLOAD_BUDGET` (4 MB) and the platform's ~4.5 MB, pinned by a test; past the budget it degrades by leaving the pairs out, then by refusing with the reason — never a body the platform cuts. The payload comparison now also runs over the real predicate. 2 ✓ and 3 ✓ unchanged.

---

<a id="gap-314"></a>
## GAP-314 · The unit decode at create time

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-305` (20261138: `documents.unit_code` and its decode-only guard) · *Opened 2026-10-01 by the integrator at the intelligence Round G I-13 merge, from the final review of [`GAP-305`](#gap-305): its acceptance 2 is met by a person's run of the unit-identity decode on /admin/scope, so a document created or renumbered after a run stays undecoded, and the relation goes stale with no signal.*

`documents.unit_code` is written only by `POST /api/admin/unit-identity` (the one-off backfill, service role). The two places a document number is born or changes — the Bridge at ingest (I-11's files) and `lib/documentLifecycle` / `lib/revisions.ts` creation and renumber (document-control's) — do not decode it, so `GPV-3`'s document→unit edge and `lib/scope.ts`'s decoded rule miss every document numbered since the last run.

### Do not

- **Do not guess.** The decode is the codebook's own parser (`parseDrawingNumber`); a number that does not decode stays empty and is reported, as the backfill does.
- **Do not write `unit_code` from the browser.** 20261138's guard makes it decode-only (service role); the create-time decode runs server-side, through the same planner the backfill uses.

### Acceptance

1. A document created (any door: upload, intake, split / merge, CSV import) or renumbered carries `unit_code` as the codebook decodes its number, or NULL with the reason recorded, without anyone running the backfill.
2. The /admin/scope panel says how many documents are undecoded since the last run (the staleness is visible).
3. A test creates and renumbers a document and asserts the decode.

**Owners:** intelligence I-11 (the Bridge at ingest) and document-control P13 (the creation and renumber paths it already edits) — recorded in both fleet-plan entries.


**Partial (2026-10-01, document-control Round F wave 2).** document-control P13 STATUS-TRANSITION — the document-control half: acceptance 1 for the doors document-control owns, and acceptance 3. Reproduced on `c22e35d`: `createDocumentWithFile`, a split's sheets, a merge's new target, the CSV import and a renumber left `documents.unit_code` NULL (20261138 lands a person's insert NULL and drops a renumbered document's decode) until someone ran the unit-identity decode on /admin/scope; nothing else wrote it.
- **The planner, extracted** (`lib/unitCodeDecode.ts`, new, server-only — it imports `lib/supabaseAdmin`): the backfill's keyset reader (`readAll`, pages until an EMPTY window), the codebook's whole unit list (`readCodebookUnits`, `loadDecodeBook`), the guarded `documents.unit_code` writes (`documentChunks` — a write lands only while the number is still one the plan decoded) and their bounded waves (`applyWrites`), moved verbatim out of `POST /api/admin/unit-identity`, which now imports them; its behaviour is unchanged (its 46 tests pass; one source pin follows the reader into the helper). New in it: `decodeDocumentUnitCodes({ orgId, documentIds })` — re-reads the given documents' STORED numbers in the org with the service role, plans with `planUnitIdentity` (the codebook's own parser — never a guess), writes through the same guarded writes, and answers per document: `decoded`, `unchanged`, `cleared` (a stale code on a number that no longer decodes), `not_decoded` (with the planner's reason: no number, no match — the codebook's own explanation —, no unit segment, a unit the codebook does not hold), `no_opinion` (no number format / no units: nothing written), `changed` (renumbered between the read and the write: left as it is), `refused`, `not_found`. intelligence I-11 reuses it for the Bridge at ingest.
- **The route** (`app/api/documents/unit-code/route.ts`, `POST`, member-callable): an active member of the org; only documents their OWN session can read (the documents RLS through `callerScopedClient`) — any other id is answered `not_found` and never decoded or named; nothing in the body but the ids is read (a number or a code sent with them is ignored); at most 200 per call. A call that wrote a code, cleared one or left one without a code records ONE `UNIT_CODE_DECODE` audit row (service role; per document: id, outcome, code, reason — "NULL with the reason recorded"); a call that only confirmed current codes records nothing. Before 20261138 it decodes nothing and says so *(corrected at the final review fix: since the third review fix it says nothing — before 20261138, or while the org's codebook cannot decode a number, it answers `{ results: [], notes: [] }`, decides, writes and records nothing, and the door shows no follow-up)*.
- **The doors** (`lib/unitCodeClient.ts` `requestUnitCodeDecode`, new — best-effort, never throws, ids only; each route call is aborted after 15 s, `UNIT_CODE_TIMEOUT_MS`): after `createDocumentWithFile` (the link picker; NOT awaited — the creation returns whatever the route does; logged), the output-template filing (it tells `createDocumentWithFile` not to decode and asks ONCE after the run for every filed document — one call per 200, not one per document; the note comes back as `unitCodeNote`, which `GenerateModal` does not show yet — logged), a split's sheets and a merge's created target (`unitCodeNote` on the result, shown by the wizards with the other follow-ups), `renumberDocument` (returns `unitCodeNote`; the Renumber dialog shows it before it closes) and `reverseRenumber` (a warning), the CSV import (ids read back by number *(corrected at the final review fix: since the third review fix it decodes the ids its inserts returned; only a row whose insert returned no id is read back by its number)*; the result says how many decoded and how many were left without a code) and the metadata editor's renumber (after the save landed; logged). A decode that cannot run never fails the creation or the renumber. When the route RAN, a document it left without a code is recorded with the reason (`UNIT_CODE_DECODE`); when the call itself did not run (no session, a network failure, the timeout), the route has nothing to record — the door's note (shown or logged) is the only report, and the next unit-identity run, or I-11's staleness count, finds the document. *(Review fix: the first cut awaited the call with no timeout inside `createDocumentWithFile` — one serial route call per filed template document — and the Renumber dialog dropped its note.)*
- Tests: `lib/__tests__/dcRoundFUnitCodeDecode.test.ts` — **acceptance 3**: a document is created (NULL at insert), decoded through the browser helper → the route → the helper; renumbered (the transcribed 20261138 trigger drops the decode) and decoded to the new unit; renumbered to a number that does not decode and left NULL with the reason on the record; a stale code cleared; the route's refusals (anonymous, bad token, non-member, no ids, over 200); a body's number / code ignored; hidden and other-org documents not found, never decoded or named; unknown unit and missing number reasons; an empty codebook writes nothing; a number changed between read and write left as it is; pre-20261138; the helper is the backfill's own; every door pinned to call it after its write; nothing in the browser writes the column. `intelRoundGUnitIdentity.test.ts` passes (the backfill unchanged).

- **Said at the package's second review (DEC-31 scope, the brief's ~5-file budget).** This half went past the budget without saying so at the time: beyond its records and tests it touched `lib/unitCodeDecode.ts`, `lib/unitCodeClient.ts`, `app/api/documents/unit-code/route.ts`, `app/api/admin/unit-identity/route.ts`, `components/documents/CsvImportModal.tsx`, `lib/documentLifecycle/renumber.ts`, `lib/documentLifecycle/reverse.ts`, `components/documents/lifecycle/RenumberModal.tsx` and `lib/outputTemplates.ts` — the last is document-control P10 EDGES' file (already merged), edited for the batched decode of the template filing. Recorded here rather than split after the fact. **Two doors report a decode that did not run only to the browser console** (no session, a network failure, the 15 s timeout — the route never ran, so no `UNIT_CODE_DECODE` row exists): the link picker (`components/documents/DocumentLinkPicker.tsx`, P3 LIFECYCLE's file) — `createDocumentWithFile` fires the decode without awaiting it, so the picker has no note to show — and the output-template filing, whose returned `unitCodeNote` `components/templates/GenerateModal.tsx` does not show. Still owed, by those files' owners: the picker should surface the note (a toast once the decode settles — `createDocumentWithFile` would return the pending decode) and `GenerateModal` a result line.

- **Third review fix (2026-10-01, document-control P13).** (1) **No opinion is no follow-up.** Before 20261138 is pasted (it is pending), the route answered 200 with "The unit-identity migration (20261138) is not applied yet — nothing was decoded." as a note, so every split, merge, renumber and CSV import showed a follow-up claiming it was "recorded on each document's history; Document Control can set it from the document" — neither true. Now `app/api/documents/unit-code/route.ts` answers `{ results: [], notes: [] }` when the migration is not applied, and `requestUnitCodeDecode` returns no note; no dialog holds for it. (2) **No row per document for a codebook that cannot decode.** `decodeDocumentUnitCodes` (`lib/unitCodeDecode.ts`) checks ONCE, right after loading the Site Codebook, that it can decode at all (`bookCanDecode`: a number format with segments, and units) and returns `noOpinion` before reading the units or the documents; the route then writes nothing, records nothing and reports nothing — an org without a configured codebook no longer gets one meaningless `UNIT_CODE_DECODE` row (and ~6 queries) per created document. `worthRecording` also excludes `no_opinion`. (3) **The CSV import decodes the rows it inserted.** Each insert now returns its id (`.insert(…).select("id")`, as `createDocumentWithFile`'s does) and the decode is asked for those ids; only a row whose insert returned no id is read back by its number (a read-back by number also matched a pre-existing document with the same number in a library keyed on number + rev, decoding and counting it). A decode with no opinion shows no "Unit codes" line. (4) **Worded apart.** `LifecycleFollowUps` (split / merge) shows a unit decode that did not complete on its own — "not recorded on the document's history, and the unit code is not set by hand — only the Site Codebook's decode writes it" — and keeps "recorded on each document's history; Document Control can set it" to the clock items. Tests: `dcRoundFUnitCodeDecode.test.ts` (an empty codebook and a codebook with no units answer nothing, write nothing, record nothing and never read `units` / `documents`; before 20261138 no note from the route or the client; `worthRecording` pinned), `dcRoundFCsvImportUnitDecode.test.ts` (new, jsdom: number + rev library, P-101 Rev A already there, importing Rev B decodes one id — the inserted one — and says 1 decoded; no opinion shows nothing; both fail against the previous commit), `dcRoundFWizardFollowUps.test.ts` (the unit note worded on its own in a split; clock items and the unit note side by side in a merge). Still owed, unchanged: the console-only doors (`DocumentLinkPicker`, `GenerateModal`), the library page's `uploadOne` / `saveInlineDocNumber`, the intake door, the `transitionIn` adoption, the Bridge (I-11), acceptance 2 (I-11). The file budget was not widened by this pass beyond the files this half already touched (plus the split / merge wizards, already P13's).
**Acceptance.**
1. ◐ For the doors document-control owns — `createDocumentWithFile` (upload through the link picker, output templates), split / merge sheets, the CSV import, `renumberDocument`, `reverseRenumber` and the metadata editor's renumber — ✓, except that the link picker and the template filing report a decode that did not run only to the console (above — still owed). **Not done here (other packages' files):** the library page's bulk upload (`uploadOne`) and its inline document-number edit (`saveInlineDocNumber`) — `app/(protected)/documents/[libraryId]/page.tsx`, edited next by identity `IS-P1` / intelligence `I-12`: each should call `requestUnitCodeDecode` after its write (`"upload"` / `"renumber"`); the external intake door (`app/api/intake/upload/route.ts`, projects' file, service role — it can call `decodeDocumentUnitCodes` directly after its insert); the transition-in adoption that renumbers (`lib/transitionIn.ts`, projects'); and the Bridge at ingest (intelligence I-11, which reuses `lib/unitCodeDecode.ts`).
2. ✗ Not this package's: the /admin/scope staleness count (how many documents are undecoded since the last run) is intelligence I-11's.
3. ✓ `dcRoundFUnitCodeDecode.test.ts` creates and renumbers a document and asserts the decode.

**Partial (2026-10-02, intelligence Round G, I-11).** I-11's two limbs:
- **The Bridge at ingest.** When `computeForKnowledgeDoc` runs on an index completion (`trigger: "ingest"`), the Bridge asks document control's planner (`lib/unitCodeDecode.ts` `decodeDocumentUnitCodes({ orgId, documentIds: [documentId] })`) to decode the controlled document's own number. That is the codebook's parser through the backfill's guarded writes, recorded the planner's way. It is best effort: a decode that cannot run never fails the Bridge or ingest, and the staleness count finds the document. An on-demand sweep does not decode (the decode belongs to the number's birth or change, and the sweep is not one).
- **Acceptance 2.** `GET /api/admin/unit-identity?orgId` answers `lastRunAt` (the last finished `UNIT_IDENTITY_BACKFILL` run) and `undecodedSince`: numbered documents with no `unit_code` created or changed since that run, or all of them when it never ran. Head counts only, for the scope writer tier. The /admin/scope Unit identity panel says it before anyone runs the decode: "Last decode run … — N numbered documents created or changed since carry no decode."

**Acceptance.**
1. ◐ The Bridge's door ✓ (`lib/__tests__/equipmentBridge.test.ts` "GAP-314: at ingest the Bridge decodes the document's own unit through document-control's helper; a sweep does not"). Still owed by their owners, unchanged: the library page's `uploadOne` / `saveInlineDocNumber`, the intake door, the `transitionIn` adoption, and the console-only doors (link picker, `GenerateModal`).
2. ✓ The /admin/scope panel says how many documents are undecoded since the last run (`lib/__tests__/equipmentBridgeRoutes.test.ts` "counts numbered documents without a decode created or changed since the last finished run (all of them before any run)", "is refused to a member outside the scope writer tier").
3. ✓ (2026-10-01, document-control P13).

**Scope / residual.** OPEN on acceptance 1's other doors (listed above). A number the codebook cannot decode stays without a code and is counted, never guessed.

**Assigned (2026-10-13, integrator, I-11 merge, DEC-31).** intelligence I-26 BRIDGE REMAINDERS (acceptance 1's other doors: the library page's `uploadOne` / `saveInlineDocNumber`, the intake door, the `transitionIn` adoption, and the console-only doors).

**Resolution (2026-10-20, intelligence Round G).** Package I-26 BRIDGE REMAINDERS: acceptance 1's other doors. Each asks for the decode after its write, best-effort (DEC-90 — the decode never blocks or fails the write that landed), and a decode that did not run is said, never only logged:
- **The library page's bulk upload** (`uploadOne`, `app/(protected)/documents/[libraryId]/page.tsx`) — ONE `requestUnitCodeDecode(…, "upload")` for every document that landed (one route call per 200, bounded), never one per file, fired after the batch, its notice and its report, NOT awaited: the staging modal, the upload dock and the AI-library nudge close whatever the route does (review fix pass — the first pass awaited it before they closed, up to 15 s per call). Its note is said on the page once it settles, after whatever the batch said.
- **The library page's inline number edit** (`saveInlineDocNumber`) — `"renumber"` after the save landed, not awaited; a note shows on the page ("<number> was renumbered. …").
- **The external intake door** (`app/api/intake/upload/route.ts`, service role) — a document the door CREATES is decoded server-side through `lib/unitCodeDecode.ts` `decodeDocumentUnitCodes` (the planner itself, never the browser route), after its project reference, scheduled AFTER the response (next/server `after()`, as the door's roster pushes are; started without being awaited if it cannot be scheduled) and bounded at 8 s there — neither the submitter's 200 nor the project team's notice waits on it (review fix pass); a decode that wrote a code, cleared one or left one without a code is recorded as one `UNIT_CODE_DECODE` row (`via: "intake"`, the link's contact as the actor); no opinion (no codebook format, or 20261138 not pasted), "unchanged" and a decode that throws record nothing and are logged; the door answers 200 as before. A revision of an existing document is not decoded (its number did not change).
- **The transition-in adoption that renumbers** (`lib/transitionIn.ts` `adoptDocument`) — `"renumber"` after the move, NOT awaited: the adoption answers at once (review fix pass). A decode that did not run is told, once it settles, to `AdoptInput.onUnitCodeNote` ("<new number>: …"), which `components/projects/TransitionInPanel.tsx` says after the adoption's own sentence (single and bulk) — never in the adoption's `note` (which the bulk summary reads as "adopted without a uniqueness key") and never as "not adopted". An adoption that keeps the number asks nothing.
- **The console-only doors.** The link picker (`components/documents/DocumentLinkPicker.tsx`) now tells `createDocumentWithFile` not to decode and asks itself after the creation, not awaited; a decode that did not run is shown once it settles ("<number> was created and linked. …"). The template filing's `unitCodeNote` is in `components/templates/GenerateModal.tsx`'s result toast (a warning on success, appended to the errors otherwise).

**Acceptance.**
1. ✓ Every door: upload (the link picker, the library page's bulk upload, the template filing), the intake door, split / merge, the CSV import, every renumber (`renumberDocument`, `reverseRenumber`, the metadata editor, the library page's inline edit, the adoption) — the document-control half (P13, 2026-10-01), the Bridge at ingest (I-11, 2026-10-02) and these. Tests: `lib/__tests__/intakeUploadRoute.test.ts` "GAP-314 (I-26): a document the door CREATES is unit-decoded at create time, by id, and a decode that wrote is recorded via 'intake'; a revision is not decoded" (after the response), "… a decode that hangs never holds the submitter's 200 …" and "… the decode never fails the submission …" (a throw, no opinion, not pasted and unchanged each record nothing and answer 200); `lib/__tests__/transitionIn.test.ts` "GAP-314 (I-26): an adoption that renumbers asks for the unit decode AFTER the move, by id, NOT awaited …" (a hung decode never holds the answer) and "… without a listener the decode's note is logged …"; `lib/__tests__/intelRoundGI26UnitDecodeDoors.test.ts` (the library page's two doors, the picker, the template filing, the intake door and the adoption pinned after their writes and never awaited — no door holds back a write that landed).
2. ✓ (2026-10-02, I-11).
3. ✓ (2026-10-01, document-control P13).

**Scope / residual.** None that a criterion names. When the call itself cannot run (no session, a network failure, the timeout) the route has nothing to record; the door's note is the report, and the next unit-identity run or the staleness count on /admin/scope places the document — as for every browser door. Files outside this package's plan list: `components/documents/DocumentLinkPicker.tsx` and `components/templates/GenerateModal.tsx` (the console-only doors this record names), `lib/transitionIn.ts`, `components/projects/TransitionInPanel.tsx` (the adoption's note, review fix pass) and `app/api/intake/upload/route.ts` (projects' files, the doors this record assigned here).

---

<a id="gap-315"></a>
## GAP-315 · Confirmed topology as a reasoning input

**Verdict: BUILD LATER** · Effort: **M** · Depends on: `20261155` applied · Opened 2026-10-01 by intelligence Round G, I-09, from `FLOW-14`'s decision (`DEC-80` item 2). **Owner:** intelligence I-21 CONFIRMED TOPOLOGY (assigned by the integrator at the I-09 merge, 2026-10-01).

Confirmed `process_flows` rows are the plant's human-asserted topology. Since `20261155`, a confirmed row is one the controller tier drew or decided. Yet nothing that reasons reads them. The orchestrator's `trace_pid_lines` builds its edges from page co-occurrence (`lib/orchestrator/tools.ts` `loadLineGraph`), and revision impact never fans out by process.

### Build
1. `flowsToLineEdges(orgId)` — confirmed rows only, mapped to `lib/pidTrace` `LineEdge[]`. An asset end resolves to its tag through the registry, a unit end to its codebook unit; `lineId` is the flow id, `drawingId` the source document.
2. `loadLineGraph` merges them with page co-occurrence. Each edge's `basis` says which it is: "a confirmed flow" or "on the same sheet".
3. The graph scopes to `traceNeighbourhood` from a unit or an asset (what it feeds, what feeds it).

### Do not
- Read a `proposed` or `dismissed` row. A proposal never reaches a reasoning surface.
- Let a flow-derived answer drive a hold, an MOC or a compliance artifact.
- Infer a flow from co-occurrence and store it.

### Acceptance
1. "What is between P-101 and E-204?" names the confirmed flows on the path, and labels any co-occurrence step as such.
2. A proposal between the two is never used.
3. The graph shows a unit's upstream and downstream set from confirmed flows.

**Partial (2026-10-07, intelligence Round G).** I-21 CONFIRMED TOPOLOGY. Build items 1 and 2 have landed. Item 3 is the graph page, which this package may not edit (see Acceptance 3 below).

Reproduced first (DEC-29) on the base `6797c48`. `lib/orchestrator/tools.ts:554-561` `loadLineGraph` read only `knowledge_page_entities`, `.limit(20000)`, and nothing that reasons read `process_flows` (`FLOW-14`'s Partial lists every reader). I ran the base tool on this package's seeds. Two pieces of equipment joined only by a confirmed flow answer `found: false`, and a pair on a sheet past the 20,000th tag row is never seen. With a project max-rows below the page size, the base trace reads one response and misses a route a full read finds.

What landed:

1. **`flowsToLineEdges(orgId, client = the browser client, opts)`** (`lib/processFlows.ts:411`). The orchestrator passes the service role, and every read is scoped to the org.
   - Reads `process_flows` where `status = 'confirmed'` (`:430`), and drops any returned row that is not confirmed (`:440`), so a filter that did not hold still lets no proposal through.
   - Pages by key to `FLOW_EDGE_CEILING` (20,000), and says when that cap is reached.
   - Resolves an asset end to its live registry tag. Archived, deleted, another workspace's, or a ref that is not an id: left out and counted (`skipped`).
   - Resolves a unit end to a Site Codebook unit of the org as "UNIT <code>" (`unitTraceTag`), and lists those keys in `unitNodes`. A code the codebook does not hold as a unit is left out. The trace's keys are punctuation-blind, so a tag or reference that itself reads "UNIT-20" normalises to the same key and merges with unit 20's node.
   - Returns `LineEdge[]` with `basis: "confirmed_flow"`, `lineId` (the flow id), `drawingId` (the source document; absent for a hand-drawn flow) and `label` (the stream).
   - A missing flow table or column (PGRST205 / 42P01, 42703 / PGRST204), on any of its reads, answers `state: "missing"`. Any other failure answers `"error"` with the message, never "no flows".
   - Bounded in time when the caller passes `opts.deadline` (fix pass 3, `FlowEdgeReadOptions`, `:342`): no flow page, asset chunk or codebook chunk starts past it (`:426`, `:452`, `:467`), and a read stopped there answers `"error"` (`FLOW_READ_OUT_OF_TIME`), never a part-resolved set that would leave flows out as if their equipment were gone. Every flow read needs a resolution round trip after its last page, so, unlike the tag index, no closing page is let through. Without a deadline (any other caller) the read is not time-bounded, as before.
2. **`loadLineGraph(ctx)`** (`lib/orchestrator/tools.ts:961`).
   - Runs the tag-index read and `flowsToLineEdges(ctx.orgId, supabaseAdmin, { deadline })` together, the deadline being the tag index's own `LINE_GRAPH_READ_BUDGET_MS` (fix pass 3). A flow read past it carries `confirmed_flows_unavailable` ("…could not be read (reading them took longer than one trace may spend on it)…"), and the trace uses sheet co-occurrence alone.
   - Puts the confirmed-flow edges first, then the co-occurrence edges, now `basis: "same_sheet"`. When a confirmed flow and co-occurrence join the same pair, the flow is the step a route names, and the step still cites the sheets that carry the pair (fix pass 3, below). Between two different routes of equal length, breadth-first order decides, not the basis: the flows in id order, then the sheets in (`document_id`, `page`, `tag`) order (fix pass 2). The base read left the rows inside a document in no stated order, and the first pass ordered them by random id.
   - Keeps SURF-7's hidden-sheet filter (`if (hidden.has(row.document_id)) continue;`, `:1010`) and extends it to flows (`:1033`). A confirmed flow read off a sheet the caller cannot open is not walked. When the mirror hop fails closed, every flow read off a sheet is hidden. A hand-drawn flow is the org's shared map and is always walked.
   - A confirmed flow that cites another workspace's knowledge document is not walked, and that document's id is never named (fix pass 2, `notOrgsOwn`, `:852`). `unreadableMirrors` looks a document up by id alone, so before this a legacy row that `20261155` counted and kept (IRLS-11) and that cites another org's upload passed it, was walked, and put that document's id in `drawings`. The check reads `knowledge_documents` by the org and the id. A failed read hides every flow read off a sheet (fails closed).
   - Both readability checks (the mirror hop, `unreadableMirrors` `:143`, and `notOrgsOwn`) are bounded in time (fix pass 4). Before, they ran over the documents of up to 50,000 rows, in chunks of 200, outside the read's budget. Now they get `LINE_GRAPH_CHECK_BUDGET_MS` (5 s, `:791`) from the moment the reads end: no chunk, and no readability call, starts past it (`budgetSpent`, `:130`). An id not checked by then is treated as unreadable or as not the org's own, so its sheet or flow is not walked (fail closed), and the answer carries `graph_partial` ("PARTIAL: checking which of the drawings you may open took longer than one trace may spend on it (5 s)…"). The allowance runs from the reads' end, not from the trace's start, so a read that used its whole budget and its closing page still has its rows checked. Without a budget (every other caller of `unreadableMirrors`) the hop is unchanged.
   - The graph is read once per run (fix pass 4, `lineGraphFor`, `:1072`). The orchestrator builds one `ToolContext` per run (`app/api/orchestrator/route.ts:208`) and passes it to every step (`lib/orchestrator/loop.ts:314`), and the graph depends on nothing else (the org, and the caller's principal through the checks). So a run that traces several pairs reads the tag index, the flows and the checks once, and each later trace answers from that graph, its ceiling or time-budget PARTIAL note included. A load that throws is not kept, nor (fix pass 5, `worthKeeping`) one a failed read degraded: a first page that failed (`graph_unavailable`), a later page that failed, a flow read that failed (`confirmed_flows_unavailable`, save the out-of-time one), or checks that ran out of time. That trace answers from it, saying so, and the next trace on the run reads again, as the base (which read on every call) did. Until fix pass 5 one transient failure answered every later trace of the run, for any pair: the reviewer's reproduction, the first page failing once (57014) and the database recovering, then the next trace on the same context answering "P-101 doesn't appear" with `graph_unavailable` and reading nothing, where the base and a fresh context found `[P101, T150, E204]`. A graph stopped by the ceiling or a time budget is kept: a second read would most likely stop at the same place at the same cost. So "once per run" is a cost bound: a graph a transient failure degraded never answers a later trace, and a graph stopped by the ceiling or a time budget answers the run with its PARTIAL note (its cut page included). Before, each `trace_pid_lines` call re-read everything, and a run of several traces on a large org could use up the 75 s run budget (`LOOP_BUDGET_MS`) on reads.
   - The tag-index read is ING-10's residual: `readTagIndex` (`:913`) pages to `LINE_GRAPH_ROW_CEILING` (50,000) and to `LINE_GRAPH_READ_BUDGET_MS` (10 s). The order is (`document_id`, `page`, `tag`, `id`), the prefix of the existing `knowledge_page_entities_locate_idx` (`document_id`, `page`, `tag`) (fix pass 2). It is paged by KEY on that whole order (fix pass 3, `tagRowsAfter`, `:879`): each page asks for the rows after the last one read (`.gte("document_id", …)` plus a four-term `.or()`, every text value a quoted literal), never by OFFSET. Until fix pass 3 it was an OFFSET read (`readAll`), and a sheet re-indexed while the trace paged (its rows deleted before a later page) shifted the next sheet's rows back across the page boundary, so they were never read and nothing said so (`lib/knowledgeAskGuards.ts` `readAllByKey` documents the same hazard); each page also re-scanned the rows before it. No data page starts past the budget, with one exception (fix pass 2): when the page before came back short, the page that would close the read is still asked for, once. So a read whose last data page is short and ends past 10 s is whole, not partial; one whose last data page is full (an index an exact multiple of the page size) and ends past the budget is called partial and its last page dropped (named in fix pass 5, not changed). With a max-rows below the page size every page is short, and the read still stops one page past the budget. Stopped by either, the sheet page the read stopped in is dropped and the answer carries `graph_partial` ("…is NOT proof the equipment is unconnected"). The cut is one page (fix pass 5): edges are built per `document_id#page`, and the order keeps a document's pages together and in page order, so only the page the stop fell in (or the first page past the ceiling) can be incomplete; every page before it, of the same document too, was read whole and is walked. Until fix pass 5 the whole document was dropped, every sheet of a multi-sheet P&ID PDF, so a pair on a complete earlier page of it, which the base's single read found, answered "doesn't appear" plus PARTIAL (the reviewer's reproduction: 900 filler rows, then a document whose page 1 holds the pair inside the first page and whose later pages run past it, with the second page failing). A page that fails after earlier pages read is a stop too (fix pass 4): the rows read are kept, the sheet page the last of them is on is dropped, and `graph_partial` names the failure ("PARTIAL: a page of the drawing tag index could not be read (<message>)…"). Until fix pass 4 such a failure discarded every row read, so one transient failure on any later page lost sheet answers the base's single read gave. A failure on the first page leaves the graph to the confirmed flows alone, and the answer carries `graph_unavailable` ("…NOT proof — say the trace could not be checked").
3. **`trace_pid_lines`.**
   - A unit is a whole operating unit, not a piece of equipment, and no walk passes through one (fix pass). A route, and the undirected `connected` neighbourhood, take a flow with a unit end only when that unit is the trace's own start or end (`equipmentWalk`, `lib/orchestrator/tools.ts:834`). Walked through, a unit would put every asset it feeds or is fed by two runs from every other, and a route through it would displace the drawn one. The `basis` says so ("A UNIT<code> tag is a whole operating unit (a Site Codebook unit), not a piece of equipment…").
   - The answer names the flows only where it rests on one (fix pass 2; until then it did so whenever the org held any walkable confirmed flow, so one unrelated flow changed every trace's `basis`, added a `route` of only "same sheet" steps, and gave every neighbourhood an empty `confirmed_flows`).
   - A found route rests on a flow when one of its steps is a confirmed flow (`:603`). Only then does it carry `route`, one entry per step (`:679`). Each entry gives `basis: "confirmed flow"` with `flow` ("P101 feeds E204", or "(this step runs against the flow)") and `stream`, or `basis: "same sheet"` (and `off_page`). Its `basis` (`TRACE_BASIS_WITH_FLOWS`, `:725`) names both sources, per step in `route`, and says proposed or dismissed flows are never used.
   - A flow step whose pair the sheets also join keeps that evidence (fix pass 3, `:650`-`:696`). The step lists every walkable sheet carrying the pair in `also_on_sheet` (`:689`), in walk order, and those sheets are merged into `drawings` in route order after the step's own source (`:672`); the first of them, the edge the sheets alone would take for that step, keeps its off-page mark (`off_page` on the step, and `crosses_sheets`). The route's `basis` says such a step names both sources. A hidden sheet is never among them (they come from the walk). So where a route is the sheets' own, every sheet the sheets-only answer cited is still cited. Until fix pass 3 the flow took the step and its sheet was dropped: with sheetSeed plus hand-drawn flows P-101 → T-150 → E-204, the base answered `drawings: ["k-a"]` and the branch `[]`; with the flows read off PFD k-c, `["k-c"]` in place of the P&ID.
   - A route through a flow that differs from the route the drawings alone give names the drawings' route beside it (fix pass 4, `sheet_route`, `:614`). Breadth-first search over the walk takes the fewest runs, and the flows come first, so a confirmed flow that joins the two ends directly (a PFD-level flow, say) replaces a longer drawn route. The answer's `path` stays the flow's route; `sheet_route` gives the route the sheets alone give (`path`, `drawings`, `crosses_sheets`, computed as the sheets-only trace computes them, so never over a hidden sheet), whenever its tags differ from `path`'s. The route's basis says: "When `sheet_route` is present, the drawings alone give a DIFFERENT route between the two (…): name both routes, and do not drop the equipment the drawn route passes through." A route through the same tags as the drawings' has none (its steps carry their sheets, above). Until fix pass 4, with sheetSeed plus one AI-read confirmed flow P-101 → E-204 off PFD k-c, the base answered `path: [P101, T150, E204]`, `drawings: ["k-a"]` and the branch `path: [P101, E204]`, `drawings: ["k-c"]`, with nothing saying the P&ID draws T-150 between them.
   - A no-route answer rests on a flow when its own start or end is on a confirmed flow the trace could walk, or when the sheets alone would give it a different reason (flows elsewhere lengthening the search to its 25-run limit). Its `basis` is `NO_ROUTE_BASIS_WITH_FLOWS` (`:741`): the two sources searched, with no `route` named.
   - In neighbourhood mode, `confirmed_flows.feeds` and `.fed_by` are `traceNeighbourhood` over the confirmed flows alone, followed only their stored way (`lib/pidTrace.ts:225`, new optional `direction`), naming a unit and stopping there (new optional `terminal`). This is the "scoped by traceNeighbourhood" answer: what it feeds and what feeds it. `confirmed_flows.connected_through_flow` names the tags in `connected` that only a confirmed flow brings that close (`:561`): the sheets alone do not reach them in as few runs. Every other tag is exactly where the sheets alone put it. `confirmed_flows` appears only when one of the three lists is non-empty. Its `note` says an empty `feeds` / `fed_by` means no confirmed flow is recorded that way, NOT that nothing feeds the item. The `basis` (`NEIGHBOURHOOD_BASIS_WITH_FLOWS`, `:752`) names no `route`, which this mode does not have.
   - A flow read that failed adds `confirmed_flows_unavailable`. More than 20,000 confirmed flows adds `confirmed_flows_partial`.
   - Otherwise every field is the base commit's, key for key (`SHEET_BASIS`, `:719`, is the base sentence). That covers no flows at all, only proposals or dismissals, a database without the table or column, every flow on a hidden sheet or citing another workspace's document, an equipment-to-equipment trace in an org whose only flows have a unit end, and flows that the route, the neighbourhood and the trace's own ends do not touch. A route that takes no flow step is the route the sheets alone give (a breadth-first route whose every step is a sheet edge is that one; pinned on 4,000 random graphs). Between two equal-length sheet routes, which one is named follows the sheet order above, which the base did not fix. A no-route answer with neither end on a flow can still differ from the base's: flows elsewhere can lengthen its search to the 25-run limit, and then its reason differs and it names the flows (the case above).
4. **`lib/pidTrace.ts`.** `LineEdgeBasis` (`:30`), `LineEdge.basis` / `label`, `TraceStep.basis` (carried only when the edge names one, so every existing step is unchanged), and `traceNeighbourhood`'s optional `direction` and `terminal` (omitted: undirected and nothing terminal, as before).

Not changed, by the regression rule: the tool's catalogue description (the text the model reads for every org) and its parameters. The model learns that flows were walked from the answer's `basis`, `route` and `confirmed_flows`. A unit is asked for as "Unit <code>" (it normalises to the unit's key).

**Do not, kept.**
- No `proposed` or `dismissed` row is read into a trace: filtered in the query and again per row; tested with a status filter that does not hold.
- Nothing flow-derived drives a hold, an MOC or a compliance artifact. A census test pins `flowsToLineEdges`'s one consumer (`loadLineGraph`, called only through the per-run `lineGraphFor`, which only the read-only `trace_pid_lines` calls). No write tool's body reaches the trace, and the orchestrator has no hold or MOC tool.
- No flow is inferred from co-occurrence or stored: nothing here writes.

Tests: `lib/__tests__/intelRoundGConfirmedTopology.test.ts` (new, 70 cases).
- REGRESSION, against goldens that the base tool produced for the same seeds: no flows; only a proposal and a dismissal (also with a status filter that does not hold); PGRST205 / 42P01 / 42703 on the flow read and 42703 on the registry read; every flow on a hidden sheet. Each gives the base output, key order included, for a path, a same-sheet hit, a not-found reason and a neighbourhood. And an org whose only flows have a unit end (unit 20 feeds both ends of a drawn three-sheet route): today's route and neighbourhood, key for key; `connected` for an asset the unit feeds is today's, and its `fed_by` names the unit and stops.
- REGRESSION (fix pass 2): an org with confirmed flows that touch none of the traced equipment (an asset-to-asset flow and a unit-ended one) gives the base path, same-sheet hit, not-found and neighbourhood, key for key; a confirmed flow at a route's own end that the route does not take leaves the route and the same-sheet hit as they were.
- Where the answer rests on a flow (fix pass 2): a neighbourhood a flow reaches into (`connected_through_flow`, the empty-list sentence, no `route` in the basis); a flow that repeats a sheet pair brings no tag closer; a no-route answer at a flow's end (the end on a flow alone, or on a sheet too) and one whose reason a flow chain changes; neither end on a flow gives the base not-found.
- IRLS-11 (fix pass 2): a flow citing another org's upload is not walked and its id is not named, and once the document is the org's own it is walked; the org check failing hides every flow read off a sheet, never the hand-drawn map.
- Confirmed flows: a confirmed flow names its basis, direction and stream, both ways; a mixed route labels both kinds of step; a proposal between the two is never used; when a flow and co-occurrence join the same pair, the flow is the step named and the sheet is still cited (`also_on_sheet`, `drawings`; fix pass 3); unit ends resolve, and archived, deleted, other-org, non-id and non-unit ends are left out; the directional neighbourhood; a route may start or end at a unit and never passes through one (siblings fed by one unit are not "between" each other), and a directional list stops at a unit.
- The hidden filter on flow edges: unreadable then readable; the mirror hop failing closed.
- Paging: rows past 20,000 are read; a max-rows below the page size; past 50,000 the page the ceiling cuts is dropped (a pair on it, both rows inside the ceiling, is not a route; a pair on an earlier page of the same document is, fix pass 5) and the answer says PARTIAL; no page starts past the 10 s budget, the page being read is dropped, the pages before it are walked, and the answer says PARTIAL; a read whose short last data page ends past the budget still asks for the closing page and is whole, and with a max-rows below the window the closing page is asked for once (fix pass 2); a page that fails first (with flows and without) carries `graph_unavailable`; one that fails behind good pages is a stop (fix pass 4, below).
- `flowsToLineEdges`: the browser client by default; keyset paging with short pages; the 20,000-flow ceiling; a failed read never answers "no flows".
- Fix pass 3. REGRESSION: sheetSeed plus confirmed hand-drawn flows on both of the route's pairs keeps the base's `drawings: ["k-a"]`, and each step is a `"confirmed flow"` with `also_on_sheet: ["k-a"]`. Flows read off a PFD cite it beside the P&ID (`["k-c", "k-a"]`), never in place of it. Every sheet carrying the pair is named, in walk order, a hidden one never, and both ways round. An off-page continuation on the pair keeps `off_page` and `crosses_sheets` as the sheets alone say them. A flow step on a pair no sheet joins cites none. The tag index paged by key: a sheet whose rows are deleted before the third page shifts no later sheet out (an OFFSET read misses the pair on k-3); the second page's cursor is pinned literally; a tag holding a comma, parentheses, a dot, a quote and a backslash is carried as one quoted literal. The flow read's deadline: no flow page, asset chunk or codebook chunk starts past it, and the read fails rather than resolve part; the trace passes its own budget and says so, with the sheets answering as before. Each was mutation-checked (dropping the `drawings` merge, `also_on_sheet`, the off-page carry, the keyset cursor for an OFFSET window, the literal quoting, each `deadline` check, or the deadline argument fails at least one test).
- Fix pass 4. REGRESSION, the reviewer's scenario: sheetSeed plus one AI-read confirmed flow P-101 → E-204 off PFD k-c keeps `sheet_route.path` and `sheet_route.drawings` equal to the base answer's (`[P101, T150, E204]`, `["k-a"]`), and the basis carries the sentence; hand-drawn, the same. A flow route of the same length through other equipment names the drawn route too, with its off-page mark. No drawn route, or one only on a sheet the caller cannot open, gives no `sheet_route` (and never names the hidden sheet); a route through the same tags as the drawings' has none. The reviewer's tag-index scenario: P-101 and E-204 on k-a page 1, 1,500 filler rows, the second page failing (57014) — the pair is found on k-a, with `graph_partial` naming the failure and no `graph_unavailable`; the sheet the failed page cut is not walked, the flows still answer. Two traces and a neighbourhood on one run's context read the tag index (two pages) and the flows once, and another context reads again; a load that throws is not kept. With mirror lookups costing 3 s, the third chunk never starts, its sheet is not walked, and the answer says PARTIAL (5 s); a flow whose org check could not start in time is not walked; a mirror whose readability call could not start in time is not walked. Each was mutation-checked (dropping `sheet_route`, its path comparison or its basis sentence; discarding the rows read before a failed page, or keeping the sheet it cut; calling `loadLineGraph` directly; keeping a load that threw; each of the three `budgetSpent` checks; not passing the budget; not hiding the ids left unchecked — each fails at least one test).
- Fix pass 5. REGRESSION, the reviewer's scenario: the first page fails once (57014) and the database recovers; on one context, trace 1 (P-101 → T-150) carries `graph_unavailable`, trace 2 (P-101 → E-204) reads again and answers the base's `[P101, T150, E204]` with no `graph_unavailable`, and a third trace reads nothing. A later page that failed once, a flow read that failed once, and checks that ran out of time are read again by the next trace on the same context; a read stopped by the time budget (seven pages) or the ceiling (51 pages) is kept, the next trace reading nothing. The reviewer's cut scenario: 900 filler rows, a multi-sheet document whose page 1 holds the pair inside the first page and whose pages 2..301 run past it, the second page failing — the pair is found on it, with `graph_partial` naming the failure. The ceiling and time-stop cases now put the pair on page 2 of a document whose page 1 was read whole: the pair on the cut page is not a route, and the pair on page 1 is. Each was mutation-checked (keeping a degraded graph, any one of the four conditions; evicting a ceiling- or time-stopped one; cutting by document, or by the last row read at the ceiling — each fails at least one test).
- The consumer census (fix pass 4: `loadLineGraph(ctx)` once, inside `lineGraphFor`, which the trace tool alone calls), and the pidTrace basis, direction and terminal nodes. On 4,000 seeded random graphs (fix pass 2): a route with no flow step equals the route the sheets alone give, and a neighbourhood with no tag through a flow equals the sheets' own.

`lib/__tests__/sweepRoundC.test.ts`'s service-role stand-in answers a tag-index page after the first (one that carries the keyset `.gte`) with an empty page, as PostgREST does for a seed that fits one page, and its two tag rows carry ids (fix pass 3; the first pass had it answer `.range()` windows). Its SURF-7 pins (`if (hidden.has(row.document_id)) continue;`, no `loadLineGraph(ctx.orgId)`) are unchanged and pass.

**Acceptance.**
1. ✓ "What is between P-101 and E-204?" names the confirmed flows on the path (`route[].basis: "confirmed flow"`, with the flow and its stream) and labels any co-occurrence step as `"same sheet"`. A flow step whose pair is also on a sheet names that sheet too (`also_on_sheet`, kept in `drawings`; fix pass 3). When the flows give a different route from the drawings' (a flow that skips over a longer drawn route), the drawings' route is named beside it, with its intermediate equipment and its sheets (`sheet_route`; fix pass 4); until fix pass 4 that held only where the route was the sheets' own, and a skipping flow dropped the drawn route and its P&ID unsaid. A unit both feed is not a path between them (fix pass).
2. ✓ A proposal (or a dismissed row) between the two is never used.
3. ✗ Not done here. The graph showing a unit's upstream and downstream set is `app/(protected)/graph/**` / `components/graph/**`. I-24 edits those files in parallel, and they are not in this package's file list. It needs no new data layer: `flowsToLineEdges(orgId)` (browser client, RLS) plus `traceNeighbourhood(edges, unitTraceTag(code), hops, "downstream" | "upstream", new Set(unitNodes))`.

**Scope / residual.** Still open: acceptance 3 / build item 3, the graph's scope filter. The integrator names the owner (the next package that edits the graph page). Answers do change in two ways for an org with confirmed flows or with a large tag index, and both are this gap and ING-10 working, not regressions:
- an org with confirmed flows gets routes through them;
- a tag index larger than the project's max-rows is now read to the end or to 50,000 rows. The base `.limit(20000)` read was capped by PostgREST's max-rows (1,000 by default on Supabase), and answered "doesn't appear" for anything past it.

**Assigned (2026-10-13, integrator, I-21 merge, DEC-31).** Acceptance 3 / build item 3, the graph's scope filter: intelligence I-15 GRAPH SERVER ASSEMBLY (the next package that edits the graph page).

A trace of a large index costs up to 51 sequential page reads where the base issued one, each filtered on `org_id` (which `knowledge_page_entities` does not index). Since fix pass 3 each page is a keyset seek from the last row read (`document_id >= …` plus the `.or()` cursor) rather than an OFFSET that re-scans every row before it, and the order follows the prefix of the existing (`document_id`, `page`, `tag`) index (fix pass 2), so the database may walk that index from the cursor rather than sort. Nothing is measured on a real table, so the read is bounded in time (`LINE_GRAPH_READ_BUDGET_MS`, 10 s, inside the orchestrator's 75 s loop budget: no data page starts after it, though one already running finishes) and says PARTIAL when it stops there; the confirmed-flow read and its end resolution are bounded on the same clock (fix pass 3); the readability checks after them have their own 5 s (fix pass 4); and a run reads the graph once, however many pairs it traces (fix pass 4), unless a failed read degraded it, when the next trace reads again (fix pass 5). One graph load is so bounded by the two budgets plus a page and a chunk already running when each runs out; it is not measured either. A keyset read is not one snapshot either: a sheet re-indexed while the trace pages can be read part old, part new, but no row that stayed in the index throughout is skipped. **For the integrator (merge request, no migration here):** if real orgs report PARTIAL on time, add an index on (`org_id`, `document_id`, `page`, `tag`, `id`), the keyset's own order under the org filter (an index led by `kind`, as proposed before fix pass 3, would leave the ordered read to merge across the four kinds), with its probe in `lib/schemaExpectations.ts`. This package added neither, and `20261187` is unused.

**Resolution (2026-10-20, intelligence Round G).** I-15 GRAPH SERVER ASSEMBLY — acceptance 3 / build item 3 (assigned at the I-21 merge, 2026-10-13). Reproduced first (DEC-29): on `8224f80` nothing under `app/(protected)/graph/` called `flowsToLineEdges` or `traceNeighbourhood`. What landed, with no new data layer: `app/(protected)/graph/page.tsx` `showReach` (`:698`) — on a selected Site Codebook unit (or an item of equipment) the page offers "What it feeds (downstream)" and "What feeds it (upstream)"; each reads `lib/processFlows` `flowsToLineEdges(orgId)` (the browser client, RLS; CONFIRMED rows only, in the query and per row) and walks `lib/pidTrace` `traceNeighbourhood(edges, unitTraceTag(code) | the tag, 6, "downstream" | "upstream", new Set(unitNodes))` — a unit is a place the walk stops, never passes through. The set is lit on the map, listed with each item's runs, and "Show only this set on the map" scopes the drawn map to the start and its set (and back). A read that fails, or a database without the flow table, is said — never "nothing feeds it"; no flow recorded that way is said as not proof; more flows than one read takes is said; items not on this map are counted.

Tests: `lib/__tests__/graphPageRender.test.ts` "FLOW-14 done-when 3 / GAP-315 acceptance 3 — …" (four cases: downstream lit, listed and scoped then restored; upstream stopping at a unit; the empty / failed / missing sentences; nothing read for a document or until asked). `lib/__tests__/intelRoundGConfirmedTopology.test.ts`'s consumer census (DEC-80 item 2 — nothing flow-derived drives a hold or an MOC) now admits exactly two readers: the orchestrator's read-only trace, as before, and the page's one `flowsToLineEdges(activeOrgId)` call inside `showReach`, whose body writes nothing (pinned: no insert / update / upsert / delete / `createManualFlow` / fetch).

**Acceptance.**
1. ✓ (I-21) unchanged.
2. ✓ (I-21) unchanged.
3. ✓ The graph shows a unit's upstream and downstream set from confirmed flows (lit, listed, and the map scoped to the set on request).

**Scope / residual.** Revision impact by process (`lib/impact.ts`, `lib/revisionImpact.ts`) stays outside this gap, as FLOW-14's record already says. The reach reads the flows through the browser client (as `flowsToLineEdges` was built to), not through `/api/graph`: the flows are member-readable and carry no document text.

---

## GAP-316 · One view of how an asset came to be believed

**Verdict: BUILD LATER** · Effort: **S–M** · Depends on: `20261171` applied · Opened 2026-10-20 by intelligence Round G, I-26 (review fix pass), from `GAP-303` acceptance 1, so that remainder is a finding of its own rather than an unowned line on that record (DEC-31). **Owner:** intelligence I-32 PROVENANCE VIEW AND WIZARD ADOPT — `GAP-303` acceptance 1, which this finding is, was assigned to it by the integrator at the I-15 merge (2026-10-20, DEC-90; DEC-31); recorded here at the I-26 merge fix pass.

Every piece of an asset's story is recorded and shown somewhere: the asset's `origin` / `discovered_from` (with its door), each link's who / which sheet / which revision / which model (`document_assets`, `knowledge_document_assets`), and every decision's audit row (`EQUIPMENT_BRIDGE_APPLIED`, `_DISMISSED`, `_RELATION_REMOVED`, `_VANISHED_*`, `_DISCOVERED`). No one view puts them together.

### Build
1. On the asset hub, one "How we came to believe this" section: the discovery (door, source, who), then each link in order — asserted by whom, or read from which sheet of which revision by which model — then each decision that changed it.

### Do not
- Store a confidence score or a summary; read the records that exist.
- Show a link or a decision the reader cannot see (each read under the reader's RLS).

### Acceptance
1. For any asset, the hub shows the complete story of how it came to be believed — asserted by whom, or read from which sheet of which revision — from the records alone.

**Resolution (2026-10-20, intelligence Round G).** Package I-32 PROVENANCE VIEW AND WIZARD ADOPT, under `DEC-90` ruling (1): ONE per-asset provenance view on the asset hub that lists every relation (`document_assets` and `knowledge_document_assets`) with who or what asserted it, read under the viewer's own RLS and the I-12 read predicate. A relation on a document the reader may not read is not shown and not counted. A failed read says so, never "none". Reproduced first (`DEC-29`): on `a21c718`, `app/(protected)/assets/[tag]/page.tsx` listed each link's who / sheet / revision / model per document row (`:460-479`), but nothing read `knowledge_document_assets`, the asset's `discovered_from`, or the `EQUIPMENT_BRIDGE_*` decisions on the hub, and no route or component put them together.

What landed:
- **`GET /api/assets/provenance?orgId&assetId`** (`app/api/assets/provenance/route.ts`, new). Every read runs as the caller (`callerScopedClient`, their own RLS):
  - the asset, with `origin` / `discovered_from` (falling back without them on a database before `20260928`) and `created_by` (BR-8's accountable identity — added at the review fix pass);
  - the relation (`document_assets`), its `20261171` / `20261170` columns dropped one step at a time;
  - `knowledge_document_assets` (`42P01` / `PGRST205`: not installed — `20261235` unpasted — said, never a failure);
  - the equipment sweep's decisions (`audit_logs`, `EQUIPMENT_BRIDGE_*`, the workspace's newest 1,000; a decision is kept only if its details name this asset by id or by its tag in the one grammar);
  - the documents and uploads named;
  - the names of the people who entered, linked or decided (`org_members`, as the caller).

  Then every controlled document is put to `readableControlledDocIds` (the I-12 predicate): a linked one, a decision's, the discovery's source, and the source of a knowledge mirror. A document either rule refuses takes its links, its decisions and the discovery's naming of it out of the answer, and nothing counts them. A predicate that cannot decide answers 503 and no story (fails closed). An unreadable principal answers 503; a non-member 403. Every other failed read is a sentence in `notes` ("… none of them is shown, which is not the same as none"), and the answer carries each section's own read state — `linksIncomplete` (a relation read, or the documents / uploads read, failed) and `decisionsUnread` (the audit read, or the documents / uploads read, failed) — so the view never presents an unread section as "none" (added at the review fix pass). The service role reads only the caller's identity and the access facts the I-12 predicate needs (memberships, teams, libraries, folders, document ACL rows — `loadPrincipal`, `readableControlledDocIds`); no relation, decision or name is read through it *(corrected at the review fix pass: first written as "The service role reads only the caller's identity", which claimed more than the code does)*. No write, no AI call. The route is `private, no-store`.
- **`lib/assetProvenance.ts`** (new): the pure assembly `assembleAssetProvenance`.
  - The discovery: door, source, sheets (AI-read marked), revision, automatic or not, confirmed by a person since or not, and who — the person the registry records as its creator (`assets.created_by`, `recordedBy`), named through the caller's own members read; BR-8's nil-uuid placeholder is never named. For the sweep that is the person who applied it, or, for an automatic apply, the person who turned automatic apply on, else whoever filed the drawing, and the view says which. A source the reader cannot open is "not one you can open", naming nothing, and no pages or sheets are given for it. An asset with no `discovered_from` and `origin = 'manual'` reads "Recorded in the registry as entered by a person", never "Registered by a person": `'manual'` is the column's DEFAULT (`20260928`), backfilled onto every older row, so it is the registry's record, not a fact *(the who and this wording added at the review fix pass)*.
  - Each link in time order: its target, who or what asserted it in words, the model and revision of a machine reading, the sheet and its mark, the pages, vanished / earlier rev, and when. A person's `manual` link names who linked it (`asserted_by_user`). A tag-sync row never names that uid: it is the document's last tag editor, per `20261171`'s header.
  - Each decision: words, actor, target, detail, when.
  - No score, no summary stored.
- **`lib/relationProvenance.ts`** (new): the one reading of a relation row — `relationAsserter`, `sheetReadingOf` / `sheetMarkOf`, `assetTagsName`, `linkStandingOf`. The view and the org graph's edges share it (`GAP-303`'s graph remainder, below).
- **`components/assets/AssetProvenancePanel.tsx`** (new), mounted on the asset hub for a registered asset as **"How we came to believe this"**. It is closed until asked: opening the hub reads exactly what it read before (`DEC-90` ruling (4)). Opened, it shows the discovery, "Links you can read (N)" with each link's standing ("AI-read" / "read from drawing" / "tagged · also on drawing" / "a person's link"), its asserter, sheet mark, pages and revision, then "Decisions recorded (N)". A refused or failed answer is said, and a partial answer's notes stand above the list. A section whose read failed shows no count and says so — "The recorded decisions could not be read — see above." / "The links could not be read — see above." (or "Some … could not be read" above rows that were read) — keyed on that section's own state, never on whether any note exists *(corrected at the review fix pass: as first landed a failed audit read still showed "Decisions recorded (0)" and "No recorded equipment-sweep decision …", against `DEC-90` ruling (1), and the links' empty state keyed on any note)*.

Tests:
- `lib/__tests__/intelRoundGI32Provenance.test.ts`, the route: every relation with its asserter, in order, as the caller; RLS- and predicate-refused documents not shown, not counted, nor their decisions, the discovery's source, or an upload mirroring a refused document; failed reads said; a failed documents read drops their links; `20261235` unpasted and the `20261171` / `20261170` tiers; 503 / 503 / 403 / 401 / 400 / 404; the discovery kinds.
- `lib/__tests__/intelRoundGI32Provenance.test.ts`, added at the review fix pass: each failed read sets its own section's state (audit alone → `decisionsUnread` only; knowledge relation → `linksIncomplete` only; documents → both); the discovery names the registry's recorded creator for the sweep and `'manual'` kinds; the nil-uuid placeholder is neither named nor looked up, and an unreadable name is not invented.
- `lib/__tests__/intelRoundGI32ProvenancePanel.test.ts`, rendered: no request until opened (the hub's fetches are exactly its old one); the opened story; a 503 said; no panel for an unregistered tag. Added at the review fix pass: a failed audit read never shows "No recorded … decision" nor "(0)" while the read links keep their "none"; a failed links read says so while the read decisions keep theirs; partly failed sections keep their rows with no count; the discovery's registry-recorded wording and named creator.

**Done-when (acceptance).**
1. ✓ For any registered asset, the hub shows the story from the records alone. That covers how it entered the registry (door, source and who — the registry's recorded creator; added at the review fix pass), each link asserted by whom (a named person for a manual link, a person's tags, the sweep reading the text layer, or an AI transcription with its model) or read from which sheet and pages of which revision, and each recorded decision of the sweep. All of it is read under the viewer's access. An unregistered tag has no records to tell (no panel).

**Scope / residual.** The decision read searches the workspace's newest 1,000 equipment-sweep decisions; past that, the view says older ones may not be listed. The discovery's who is the registry's recorded creator only: a creator who is no longer a member of the workspace has no `org_members` row to name them, so the discovery names no one (a failed names read is said in `notes`). Archived documents' links are shown, marked "(archived)" — they are records. The hub's own document list, its counts and the "Also read on" list are unchanged. No migration, no new table, no export decision.

---

## Already built — do not build these twice

| Looks missing | Actually |
|---|---|
| **Title-block sheet identity extraction** | **Built** — `knowledgeIngest.ts:281-292`, `kind:'self'`. The Bridge filters it out at `:64`. |
| **Tag → sheet resolution** | **Built** — computed inline at `ask/route.ts:991-995` for one chat answer, then discarded. |
| **XLSX parsing** | **Built** — `lib/xlsxData.ts parseWorkbook`, wired only to templates. |
| **The `document_assets` relation** | **Built** and trigger-maintained. What is missing is the vocabulary for a machine source (`GAP-302`). |
| **Discovered-asset provenance** | **Written** — `equipmentBridgeServer.ts:214` `discovered_from`. Read by nothing. |
| **Codebook decode of drawing numbers** | **Built** — `parseDrawingNumber`. The document has no column to store the result. |
| **Pipe/route traversal** | **Built and tested** — `lib/pipeTrace.ts`. One design agent found it wired to the wrong consumer. |
| **Proposed / confirmed lifecycle** | **Built** on flows. The pattern to extend, not to invent. |
