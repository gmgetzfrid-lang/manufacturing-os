// lib/knowledgeEntityKinds.ts — what lives in knowledge_page_entities, and
// the rule for reading it in bulk.
//
// The table holds several UNRELATED kinds of row, all written by ingestion:
//
//   equipment — tag occurrences (V-3, P-101A) with page positions
//   ref       — drawing-number references found on a sheet
//   opc       — off-page connector boxes
//   self      — the sheet's own drawing number, from its title block
//   anchor    — where a caption lives ("TABLE 3", "FIGURE 5-1"), on EVERY
//               page, prose included — so by far the most numerous kind in a
//               standards library
//   line      — a pipe line number (6"-P-1024-A1A), kept as itself rather
//               than read as equipment (DWG-2)
//
// Bulk readers pull a wide slab of this table under a row cap and then feed
// the result into DETERMINISTIC counts — equipment censuses, reference
// audits, "distinct tags" totals — presented to the user as facts to trust.
//
// A bulk read with no kind filter is therefore a live hazard, not a style
// nit: the moment a new kind is written at any volume, it competes for the
// same row cap, and whichever rows Postgres happens to return first decide
// what the census says. Nothing errors. The number just quietly gets
// smaller, in the one place the UI promises it is exact. Post-fetch
// filtering cannot help — the rows are already gone.
//
// So: every bulk read names the kinds it wants. lib/__tests__/entityKindGuard
// enforces it on the whole repo.

/** Every kind ingestion currently writes — the WHOLE inventory (ING-5).
 *  lib/__tests__/entityKindGuard.test.ts holds it to lib/knowledgeIngest.ts
 *  both ways: every `kind: "…"` the ingest writes is listed here, and every
 *  kind listed here is one the ingest writes. A new kind cannot be written
 *  without being declared, and cannot be declared before it is written. */
export const ENTITY_KINDS = ["equipment", "ref", "opc", "self", "anchor", "line"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The kinds that describe TAGS AND REFERENCES on a sheet — what every
 *  census, audit and register is computed from. Spelled out rather than
 *  "all kinds" so a future kind has to be considered rather than inherited.
 *
 *  `anchor` is deliberately NOT here: a caption's address ("TABLE 3") is not
 *  a tag, it is written on every page of every document, prose included,
 *  and in a bulk read it would swamp the drawing kinds under the row cap.
 *  Its one reader (the ask route's caption lookup) asks for it by name.
 *
 *  Nor is `line` (DWG-2): a pipe line number is not equipment and not a
 *  drawing reference, a P&ID carries dozens a sheet, and no census, audit or
 *  register counts it — a reader that wants lines asks for them by name. */
export const TAG_ENTITY_KINDS: readonly EntityKind[] = ["equipment", "ref", "opc", "self"];
