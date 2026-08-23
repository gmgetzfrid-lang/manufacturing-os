# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 258
findings and 12 gap specs are worked against. Judgment calls shared with the
other areas are settled in [`../DECISIONS.md`](../DECISIONS.md).

---

## The redo-pairs — the whole value of this sequence

Three pairs. Building the second before the first means undoing it.

### PAIR 1 · `GAP-302` before anything writes Bridge output

Three separate design proposals wanted to union the Bridge's tags into
`documents.asset_tags`. Do that and you will undo it, for three verified reasons:

1. The trigger `DELETE`s and re-derives all `jsonb_sync` rows on **every**
   `asset_tags` edit (`20260609_phase1_normalization.sql:90-113`), so a
   sheet payload hung there is destroyed by the next unrelated touch.
2. `elem->>'tag'` is the only field the trigger reads. Nothing else survives.
3. `AssetTag` is `{tag; type?; category?}` — no source field — so a
   vision-asserted tag renders identically to a drafter-typed one.

Widening the CHECK to `('jsonb_sync','manual','drawing')` and adding
`sheet_label`/`pages` is two lines and makes the honest version cost the same as
the dishonest one.

### PAIR 2 · `GAP-305` before `GAP-306`

The scope pivot cannot work while `unit:<uuid>` and `cbunit:<code>` are two
unconnected nodes. Build the filter first and it will scope to half a unit,
convincingly, which is worse than not having it.

### PAIR 3 · `GAP-301` before `GAP-304`

If the Bridge starts writing relations before the sheet address is a stored fact,
every row it writes has to be rewritten to carry one. `GAP-301` is `S`.

---

## Phase 0 — Free, and each unblocks something

| Item | Why now |
|---|---|
| **`GAP-302`** | Two-line migration. Everything downstream depends on it and nothing depends on it. |
| **`GAP-301`** | The sheet address is already extracted; one predicate excludes it. |
| **`GAP-310`** | Four tag grammars have already silently killed the alias feature in ⌘K and on the old-tag URL path. Migrate the column and flip the readers **in one commit**. |
| **`BR-*` — the `targetKey` throw above the discovery block** | `equipmentBridgeServer.ts:190-193` sits above `:197-234`, so no mapped column means zero assets created. The ordering *is* the bug. |
| **`BR-*` — the silent strip-and-retry** | `:219-224` drops `unit_code, code, origin, discovered_from` on error and `:226-230` falls through to `createdAssets: 0` with no signal. |

---

## Phase 1 — The security answer

Work `05-knowledge-acl.md` and `06-document-acl-leaks.md` in severity order. These
answer the owner's direct question and they gate nothing else, so they can run in
parallel with Phase 0 by a second agent.

⚠ **The ingest lock (`ING-*`) belongs here despite not being a security finding.**
There is no server-side ingest lock — three independent drivers can process the
same page range, and the loser hard-errors the whole document. It fires hardest
right after a rev-up, because rev-up marks documents `stale`, which is the same
queue. It also double-bills vision pages.

---

## Phase 2 — The memory

In order. This is the through-line made concrete.

1. **`GAP-303`** — provenance. Before the relation exists, not after: retrofitting
   a source column onto rows already written means a backfill that cannot recover
   what it did not record.
2. **`GAP-304`** — the Bridge writes a relation. **Keep the metadata write**; the
   drawing row's chips render from it. Make the relation authoritative.
3. **`GAP-305`** — one unit identity, and `documents.unit_code` as a real column.
4. **`GAP-309`** — revision truth. Ships with `GAP-303`'s revision field; skipping
   it means the relation starts accumulating false records immediately.

---

## Phase 3 — The doors and the ledger

5. **`GAP-307`** — any door. Move the `source_document_id` gate; wire
   `lib/xlsxData.ts` to the asset importer; add unit and code to
   `CANONICAL_FIELDS`.
6. **`GAP-308`** — the coverage report.

---

## Phase 4 — The pivot

7. **`GAP-306`** — `lib/scope.ts`.

⚠ **Argue the place before the filter.** The operating area may be the better
first delivery: the same scope resolved once, presented as somewhere you stand
rather than something you configure. His sentence — *"crude unit, all this goes
here"* — describes a place at least as much as a filter. Decide deliberately.

---

## Phase 5 — The daily surfaces

8. **`GAP-311`** — tag lookup in ⌘K. Cheapest item with the highest daily use.
9. **`GAP-312`** — the equipment field on the drafting request. **Ship with
   `GAP-110`/`GAP-111`** from the drafting-flow area or the form gets edited twice.

Then the remaining findings in severity order.

---

## Do not do these

Drawn from 45 surviving `TRAP_TO_AVOID` proposals.

| Tempting | Why not |
|---|---|
| Union the Bridge's tags into `documents.asset_tags` | The trigger eats them. `GAP-302`. |
| Make the sheet a node type, or a document row per sheet | Put it on the **relation**. A sheet node multiplies the graph and answers nothing extra. |
| Infer the unit edge at graph-assembly time | Violates `orgGraph.ts:4-5` — *"each edge is a row somewhere"* — and would fail the guard test another agent proposed in the same run. Write the decode. |
| Raise `MAX_PAGES` and vision-read the whole drawing set | **The tag→sheet map he asked for costs zero model calls.** It is already extracted. |
| Build the scope filter before the two unit identities are reconciled | It will scope to half a unit, convincingly. |
| Add a service-class keyword lexicon (`'150# steam'→utility`) in `lib/` | Would be the **first facility vocabulary ever admitted to application code**, in the product whose owner said baking in conventions boxes him into names other facilities do not use. Ship the column; let the codebook or a confirmed assertion fill it. |
| Auto-accept AI proposals above a confidence threshold | A number is not a source. `GAP-303`. |
| Let AI-derived data drive a hold, an MOC, or a compliance artifact | Hard rule. A human assertion goes in between. |
| Add a cron entry to `vercel.json` | A third entry fails every deployment on this plan (`app/api/cron/maintenance/route.ts:286-291`). Everything rides `maintenance`. |
| Write a second container-chain walk | `lib/docClass.ts:49-58` already does document → folder → library. |
| Name a graph lens after what it hides | That is the naming defect. "Process" means "everything except paper". |

---

## Verification you cannot skip

**No live database, no browser, no AI provider.** Deterministic parsers, RLS
policies and call graphs are read from code and are exact. **Nothing about model
output quality was observed** — every such claim is marked `SUSPECTED` and must be
reproduced against a real provider before it is acted on.

Per `DEC-29`, reproduce before fixing. Two specifically:

- **`21-edges-and-invariants.md` has since been verified by hand** — both
  `CRITICAL`s and the RLS-shaped `HIGH`s confirmed; the rest marked. Its record
  is at the top of the file. **`IEDGE-1` and `IEDGE-2` belong in Phase 1** with
  the other ACL work: `graph/ask` and every orchestrator read tool run the corpus
  search on the **service role**, so the ACL enforcement both files document in
  their own comments never happens.
- **The table-chunking finding in `01-ingestion.md`** was demonstrated by
  transcribing the functions and executing them on both paths. That is strong
  evidence but it is not the running system: **re-run it against a real ingested
  document before changing the chunker**, because the fix touches every chunk
  boundary in the corpus and would require a full re-index.
