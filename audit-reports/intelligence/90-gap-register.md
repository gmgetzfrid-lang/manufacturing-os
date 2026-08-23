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
