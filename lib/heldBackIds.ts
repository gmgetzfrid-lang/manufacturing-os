// lib/heldBackIds.ts — SERVER-ONLY. The documents a controller held back
// from AI reading (documents.ai_excluded), read CHECKED, for the knowledge
// pickers (/api/flows/browse, /api/area/knowledge-status).
//
// intelligence KACL-9 residual (Round G, I-29; the integrator's DEC-90 ruling
// at the I-12 merge): both pickers read the flag and IGNORED an errored read
// before calling aiReadability, so a failed read showed every held-back
// document as AI-readable (and counted it). The rule now matches the
// knowledge sync (lib/knowledgeSourceSync): an errored read WITHHOLDS — the
// caller answers "couldn't check" and shows nothing built on it (fail
// closed); a database without the column (42703 / PGRST204 — before
// 20260807) holds nothing back. The read pages by KEYSET on id until an
// empty page, so no row cap silently drops held-back documents (the
// knowledge-status read was a single unpaged select).

import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** Rows per page of the held-back read. */
export const HELD_BACK_IDS_PAGE = 1000;

/** What a picker answers (503) when the held-back read fails. */
export const HELD_BACK_UNREADABLE =
  "Couldn't check which documents a controller held back from AI — try again.";

export type HeldBackRead =
  | { ok: true; ids: Set<string>; columnMissing: boolean }
  | { ok: false; error: string };

const isMissingColumn = (e: { code?: string } | null | undefined) =>
  !!e && (e.code === "42703" || e.code === "PGRST204");

export async function readHeldBackIds(orgId: string): Promise<HeldBackRead> {
  const ids = new Set<string>();
  let lastId: string | null = null;
  for (;;) {
    let q = supabaseAdmin.from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
    if (lastId !== null) q = q.gt("id", lastId);
    const { data, error } = await q.order("id", { ascending: true }).limit(HELD_BACK_IDS_PAGE);
    if (error) {
      if (isMissingColumn(error)) return { ok: true, ids: new Set(), columnMissing: true };
      return { ok: false, error: error.message ?? String(error) };
    }
    // Strictly ascending: a page that repeats an id already read ends the
    // read instead of looping.
    const page = ((data ?? []) as Array<{ id: string }>)
      .filter((r) => lastId === null || String(r.id) > lastId);
    if (page.length === 0) return { ok: true, ids, columnMissing: false };
    for (const r of page) ids.add(String(r.id));
    lastId = String(page[page.length - 1].id);
  }
}
