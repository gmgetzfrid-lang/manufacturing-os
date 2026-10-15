// lib/estate/discoveredCheck.ts — would the reader still find this tag?
//
// Equipment discovered from drawings carries the text it was read from
// (knowledge_page_entities.raw). Re-running TODAY's reader on that text is
// the honest test of whether it is equipment: a vessel read from
// "10-V-101 CRUDE FEED DRUM" still reads; a "drum" read out of the sheet's
// own drawing number "2002-D 2001" no longer does. Pure.

import { extractEquipmentTags } from "@/lib/drawingText";

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function stillRead(tag: string, raws: string[], knownPrefixes: string[] = []): boolean {
  const want = norm(tag);
  return raws.some((raw) => extractEquipmentTags(raw, { loose: true, knownPrefixes }).some((h) => norm(h.tag) === want));
}

export type SuspectReason = "not-read-any-more" | "on-no-sheet";

/** Why a drawing-discovered item is suspect, or null when it stands. When
 *  drawings are still being read, an item on no sheet is not judged — its
 *  sheet may simply not be re-read yet. */
export function suspectReason(tag: string, raws: string[], opts: { knownPrefixes?: string[]; readingInProgress: boolean }): SuspectReason | null {
  if (!raws.length) return opts.readingInProgress ? null : "on-no-sheet";
  return stillRead(tag, raws, opts.knownPrefixes) ? null : "not-read-any-more";
}
