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
- **Picking.** The graph's scope picker (top bar `select`, `app/(protected)/graph/page.tsx:836`; a Site Codebook unit's peek, "Scope the map to this unit") sets `GraphSettings.scope` and assembles that unit's world through `buildOrgGraph(orgId, { scope })`. Boundary stubs are now DRAWN: a dashed stub with "+N" on the node in 2D, "+N out" on its label in 3D, and "N links lead out of <unit> — not drawn here" in its peek.
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

---

<a id="gap-312"></a>
## GAP-312 · The drafting request gets an equipment field

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-304`, `GAP-311`

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
