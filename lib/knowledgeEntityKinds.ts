// lib/knowledgeEntityKinds.ts — what lives in knowledge_page_entities, and
// the rule for reading it in bulk.
//
// The table holds several UNRELATED kinds of row, all written by ingestion:
//
//   equipment — tag occurrences (V-3, P-101A) with page positions
//   ref       — drawing-number references found on a sheet
//   opc       — off-page connector boxes
//   self      — the sheet's own drawing number, from its title block
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

/** Every kind ingestion currently writes. */
export const ENTITY_KINDS = ["equipment", "ref", "opc", "self"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The kinds that describe TAGS AND REFERENCES on a sheet — what every
 *  census, audit and register is computed from. Spelled out rather than
 *  "all kinds" so a future kind has to be considered rather than inherited. */
export const TAG_ENTITY_KINDS: readonly EntityKind[] = ["equipment", "ref", "opc", "self"];
