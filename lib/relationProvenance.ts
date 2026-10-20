// lib/relationProvenance.ts — intelligence Round G I-32: ONE reading of what
// a document ↔ equipment relation row says about who asserted it and where
// its sheet address came from, shared by every surface that shows it — the
// org graph's edges (lib/orgGraph.ts relationOf, components/graph/graphTheme),
// the asset hub's document list and its "How we came to believe this" view
// (lib/assetProvenance.ts). One function, so the graph and the provenance
// view cannot disagree on machine-read vs person-asserted (GAP-303's graph
// remainder) or on which sheet number is unconfirmed (GOV-9 criterion 4).
//
// Pure: no I/O.
//
// The facts it reads (document_assets / knowledge_document_assets):
//   asserted_by  'machine' | 'human' (20261171). Before it, a 'drawing' row
//                is a machine's reading by definition (GAP-302 — a person
//                cannot write one); every other row is a person's.
//   model        the AI model that transcribed the page the tag was read on
//                (NULL: the PDF's own text layer).
//   sheet_label  the sheet address read off the page's title block
//                (20261170). No screen lets a person type it: a person's row
//                carries one only because the equipment sweep read it — the
//                Bridge's adopt (a person making the drawing's pair theirs)
//                and a removal that hands a pair back to the person's tags
//                keep the address and clear the model (HUMAN_PROVENANCE in
//                lib/equipmentBridgeServer.ts). Whether THAT reading was an AI
//                transcription is no longer recorded on the row, so the
//                address is said to be the sweep's, unconfirmed — never shown
//                as a plain fact (fail toward the warning, DEC-90), and never
//                called AI-read (DEC-29: the row does not say so).
//
// A machine reading whose document's own equipment tags (documents.asset_tags,
// typed by a person) also name the tag is a person's assertion as much as the
// drawing's: while a 'drawing' row holds the pair, the tag sync's own row is
// skipped, so the relation alone cannot say so (GAP-303 fix pass 2). The asset
// hub has said "tagged · also on drawing" since I-11; `assetTagsName` is the
// test every surface uses.

import { tagKey } from "@/lib/codebook";

/** The mark a sheet address read off an AI transcription carries everywhere
 *  (the asset hub, the sweep, ⌘K, the coverage report, the drawing audit, the
 *  equipment table, the graph). */
export const AI_READ_MARK = "AI-read, unconfirmed";
/** The mark a sheet address carries on a person's link: the equipment sweep
 *  read it; whether off an AI transcription is not recorded on the row. */
export const SWEEP_SHEET_MARK = "read by the equipment sweep, unconfirmed";

export interface RelationFacts {
  source?: string | null;
  asserted_by?: string | null;
  model?: string | null;
  sheet_label?: string | null;
}

/** Who asserted the link: the row's `asserted_by` (20261171) when it says;
 *  before it, a 'drawing' row is a machine's and any other row a person's
 *  (null: the row names no source — a database before 20261170 — so it is
 *  the pair it always was, a person's link). */
export function relationAsserter(r: RelationFacts): "machine" | "human" | null {
  if (r.asserted_by === "machine" || r.asserted_by === "human") return r.asserted_by;
  if (r.source === "drawing") return "machine";
  if (r.source === "manual" || r.source === "jsonb_sync") return "human";
  return null;
}

const hasModel = (r: RelationFacts) => typeof r.model === "string" && r.model.trim().length > 0;
const sheetOf = (r: RelationFacts) => (typeof r.sheet_label === "string" ? r.sheet_label.trim() : "");

/** Where the row's sheet address came from. null: the row names no sheet.
 *  "ai": read off an AI transcription of the page (the row names the model).
 *  "text": a machine's reading of the PDF's own text layer.
 *  "sweep": a person's link carrying the sweep's address (see the header). */
export type SheetReading = "ai" | "text" | "sweep";
export function sheetReadingOf(r: RelationFacts): SheetReading | null {
  if (!sheetOf(r)) return null;
  if (hasModel(r)) return "ai";
  return relationAsserter(r) === "machine" ? "text" : "sweep";
}

/** The words a sheet address carries beside it; null: a text layer's reading
 *  by a machine, said by the "read from drawing" mark beside the link. */
export function sheetMarkOf(reading: SheetReading | null): string | null {
  if (reading === "ai") return AI_READ_MARK;
  if (reading === "sweep") return SWEEP_SHEET_MARK;
  return null;
}

/** Do a document's own equipment tags (documents.asset_tags) name any of
 *  these tag keys (lib/codebook tagKey — the one tag grammar)? */
export function assetTagsName(assetTags: unknown, keys: ReadonlySet<string>): boolean {
  if (!Array.isArray(assetTags) || keys.size === 0) return false;
  return (assetTags as Array<{ tag?: unknown } | null>).some((e) =>
    !!e && typeof e.tag === "string" && keys.has(tagKey(e.tag)));
}

/** How the link reads to a person: a machine's reading alone; a machine's
 *  reading a person also tagged the document with; or a person's link. */
export type LinkStanding = "machine" | "machine_person_also" | "person";
export function linkStandingOf(r: RelationFacts, personTagged: boolean): LinkStanding {
  if (relationAsserter(r) !== "machine") return "person";
  return personTagged ? "machine_person_also" : "machine";
}
