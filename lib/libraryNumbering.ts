// lib/libraryNumbering.ts — optional per-library auto-issued document numbers.
//
// A library can own a counter (prefix + zero-padded sequence, e.g. PROC-0042)
// so procedures/RFIs/memos get clean numbers without a human inventing them.
// Drawing libraries leave this OFF — drawing numbers come from the site
// standard, not from the DMS. Issuing is an atomic row-locked RPC, so two
// simultaneous uploads can never receive the same number.

import { supabase } from "@/lib/supabase";

export interface LibraryNumbering {
  library_id: string;
  enabled: boolean;
  prefix: string;
  pad: number;
  next_number: number;
}

export async function getLibraryNumbering(libraryId: string): Promise<LibraryNumbering | null> {
  const { data, error } = await supabase
    .from("library_numbering").select("*").eq("library_id", libraryId).maybeSingle();
  if (error) return null; // pre-migration DB → feature just off
  return (data as LibraryNumbering | null) ?? null;
}

export async function saveLibraryNumbering(
  orgId: string,
  libraryId: string,
  cfg: { enabled: boolean; prefix: string; pad: number; next_number: number },
): Promise<void> {
  const { error } = await supabase.from("library_numbering").upsert({
    library_id: libraryId, org_id: orgId,
    enabled: cfg.enabled,
    prefix: cfg.prefix.trim(),
    pad: Math.max(1, Math.min(8, cfg.pad)),
    next_number: Math.max(1, cfg.next_number),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Atomically issue the next number. Null when numbering is off (or the
 *  migration hasn't run) — callers fall back to their old behavior. */
export async function issueDocumentNumber(libraryId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("issue_document_number", { p_library_id: libraryId });
    if (error) return null;
    return (data as string | null) ?? null;
  } catch {
    return null;
  }
}
