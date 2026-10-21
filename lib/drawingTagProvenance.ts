// lib/drawingTagProvenance.ts — GAP-303's drawing-viewer limb (intelligence
// Round G I-26): on the drawing viewer's equipment-tag overlay, a tag the
// equipment sweep READ off the drawing is told apart from one a person
// asserted, as the asset hub tells them apart (app/(protected)/assets/[tag]).
//
// The source is the document↔equipment relation (document_assets, 20261170 /
// 20261171), read under the viewer's own RLS (DACL-11: a link is readable
// only with its document). A 'drawing' row is a machine's reading — "AI-read"
// when an AI model transcribed the page it was read on (the row's `model`),
// "read from drawing" when the PDF's own text layer carried it — with the
// revision and sheet it was read from. A tag the document's own equipment
// tags (documents.asset_tags, typed by a person) also name is "tagged · also
// on drawing": a person asserted it, and the sweep read it too.
//
// The overlay's chips come from the document's metadata tag columns, which
// a person types AND the Bridge's apply writes — nothing records which. So a
// chip only the sweep's reading names is marked for how it was READ ("AI-read"
// / "read from drawing"), never as "not typed by a person": whether a person
// also typed it into the column is said to be unknown (DEC-29).
//
// Nothing is claimed it cannot say: a relation that cannot be read marks no
// chip (the overlay reads as it did before this file); a database before
// 20261171 has no provenance columns, so a 'drawing' row there reads "read
// from drawing" with no model — 20261171 is what records the transcribing
// model, and the Bridge writes no 'drawing' row before it (GAP-303 fix pass 2).

import { supabase } from "@/lib/supabase";
import { tagKey } from "@/lib/codebook";

export interface DrawingTagProvenance {
  /** "machine": the sweep read it off the drawing and the document's own
   *  equipment tags (asset_tags) do not name it — whether a person typed it
   *  into a metadata tag column is not recorded. "person_also": a person
   *  tagged the document with it, and the sweep read it off the drawing too. */
  kind: "machine" | "person_also";
  /** The AI model that transcribed the page it was read on; null: the PDF's
   *  own text layer (or not recorded). */
  model: string | null;
  /** The controlled revision it was read from. */
  revision: string | null;
  /** The sheet address its page's title block declares. */
  sheet: string | null;
}

export interface RelationRowForProvenance {
  tag_text?: string | null;
  source?: string | null;
  asserted_by?: string | null;
  model?: string | null;
  source_revision?: string | null;
  sheet_label?: string | null;
}

/** The tags a person put on the document (documents.asset_tags), as keys. */
function personKeys(assetTags: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(assetTags)) return out;
  for (const e of assetTags as Array<{ tag?: unknown } | null>) {
    if (e && typeof e.tag === "string" && e.tag.trim()) out.add(tagKey(e.tag));
  }
  return out;
}

/** Pure: the provenance of each tag the relation's machine rows name, keyed
 *  by the one tag grammar (tagKey). A row that is not a machine's reading
 *  (jsonb_sync / manual — a person's) gives no mark: an unmarked chip is a
 *  person's, as it always read. */
export function provenanceByTag(rows: ReadonlyArray<RelationRowForProvenance>, assetTags?: unknown): Map<string, DrawingTagProvenance> {
  const persons = personKeys(assetTags);
  const out = new Map<string, DrawingTagProvenance>();
  for (const r of rows) {
    const machine = r.asserted_by ? r.asserted_by === "machine" : r.source === "drawing";
    if (!machine || !r.tag_text) continue;
    const key = tagKey(r.tag_text);
    if (!key || out.has(key)) continue;
    out.set(key, {
      kind: persons.has(key) ? "person_also" : "machine",
      model: r.model ?? null,
      revision: r.source_revision ?? null,
      sheet: r.sheet_label ?? null,
    });
  }
  return out;
}

/** The chip's mark and its tooltip, worded as the asset hub words them —
 *  except that a chip from a tag column is never said to be "not typed by a
 *  person" (the column does not record who wrote it). */
export function provenanceMark(p: DrawingTagProvenance): { label: string; title: string } {
  const how = p.model ? `from an AI transcription (${p.model}) — check it against the sheet` : "from the drawing's own text";
  const where = [p.sheet ? `on ${p.sheet}${p.model ? " (AI-read, unconfirmed)" : ""}` : null, p.revision ? `Rev ${p.revision}` : null].filter(Boolean).join(", ");
  if (p.kind === "person_also") {
    return {
      label: "tagged · also on drawing",
      title: `Tagged on this document by a person (its equipment tags). The equipment sweep also read it off the drawing ${how}${where ? `, ${where}` : ""}.`,
    };
  }
  return {
    label: p.model ? "AI-read" : "read from drawing",
    title: `Read off the drawing by the equipment sweep ${how}${where ? `, ${where}` : ""}. Whether a person also typed it into this tag column is not recorded.`,
  };
}

const ATTEMPTS = [
  "tag_text, source, asserted_by, model, source_revision, sheet_label",
  "tag_text, source, sheet_label",
  "tag_text, source",
];
const columnMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist|could not find the .* column/i.test(e.message ?? ""));

/** Read the document's machine readings under the viewer's RLS. null: the
 *  relation could not be read (no chip is marked — nothing is claimed). The
 *  columns a database may not have yet are dropped one step at a time. */
export async function readDrawingTagProvenance(documentId: string, assetTags?: unknown): Promise<Map<string, DrawingTagProvenance> | null> {
  if (!documentId) return null;
  for (const cols of ATTEMPTS) {
    try {
      const { data, error } = await supabase.from("document_assets").select(cols)
        .eq("document_id", documentId).eq("source", "drawing").limit(1000);
      if (!error) return provenanceByTag((data ?? []) as unknown as RelationRowForProvenance[], assetTags);
      if (!columnMissing(error)) return null;
    } catch {
      return null;
    }
  }
  return null;
}
