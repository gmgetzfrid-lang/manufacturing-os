// lib/codebookServer.ts — service-role codebook access for API routes and
// ingest workers (lib/codebook.ts is the browser-client twin; the pure codec
// lives there and is shared).

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_CODEBOOK, type Codebook, type CodebookEntry, type DrawingNumberConfig, type IterableRule } from "@/lib/codebook";

export async function loadCodebookAdmin(admin: SupabaseClient, orgId: string): Promise<Codebook> {
  try {
    const [entriesRes, configRes] = await Promise.all([
      admin.from("codebook_entries").select("*").eq("org_id", orgId).order("sort").order("code"),
      admin.from("codebook_config").select("*").eq("org_id", orgId).maybeSingle(),
    ]);
    if (entriesRes.error) return EMPTY_CODEBOOK; // pre-migration DB → no opinion
    const entries = ((entriesRes.data ?? []) as Array<Record<string, unknown>>).map((r): CodebookEntry => ({
      id: String(r.id), kind: r.kind as CodebookEntry["kind"], code: String(r.code), label: String(r.label),
      meta: (r.meta as CodebookEntry["meta"]) ?? {}, sort: Number(r.sort ?? 0),
      origin: (r.origin as "manual" | "import") ?? "manual",
    }));
    const cfg = configRes.data as Record<string, unknown> | null;
    const dn = (cfg?.drawing_number ?? null) as DrawingNumberConfig | null;
    return {
      units: entries.filter((e) => e.kind === "unit"),
      equipmentTypes: entries.filter((e) => e.kind === "equipment_type"),
      drawingTypes: entries.filter((e) => e.kind === "drawing_type"),
      drawingNumber: dn && Array.isArray(dn.segments) && dn.segments.length > 0 ? dn : null,
      iterableRule: {
        mirrorsTag: (cfg?.iterable_rule as IterableRule | undefined)?.mirrorsTag ?? true,
        padTo: (cfg?.iterable_rule as IterableRule | undefined)?.padTo ?? 0,
      },
      legendDocIds: Array.isArray(cfg?.legend_doc_ids) ? (cfg?.legend_doc_ids as string[]) : [],
    };
  } catch {
    return EMPTY_CODEBOOK;
  }
}

/** Render the codebook in the exact line format the drawing-text decoder
 *  parsers already understand ("20 = Crude Unit", "E- = Exchangers") — so
 *  knowledge libraries with NO decoder of their own inherit the site's
 *  language with zero changes to the parsing layer. */
export function codebookToDecoderText(book: Codebook): string {
  const lines: string[] = [];
  for (const u of book.units) lines.push(`${u.code} = ${u.label}`);
  for (const t of book.equipmentTypes) {
    for (const p of t.meta.tagPrefixes ?? []) lines.push(`${p.toUpperCase()}- = ${t.label}`);
  }
  return lines.join("\n");
}
