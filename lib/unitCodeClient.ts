// lib/unitCodeClient.ts — the browser's side of the unit decode at create time
// (intelligence GAP-314, its document-control half; document-control P13).
//
// documents.unit_code is written only by the service role (20261138), so a
// creation door or a renumber in the browser asks POST /api/documents/unit-code
// to decode the documents it just wrote. The route re-reads their stored
// numbers server-side — this module sends ids only, never a number or a code.
//
// BEST-EFFORT, NEVER THROWS: a decode that cannot run never fails the creation
// or the renumber that called it. What did not happen comes back as a `note`
// for the caller's report (and the route records every document it left
// without a code, with why — UNIT_CODE_DECODE). Outside a browser (a server
// render, a test without a window) it does nothing: the route is the
// browser's door, and a server path calls lib/unitCodeDecode.ts directly.
// The next unit-identity run on /admin/scope places anything this missed.
//
// BOUNDED (P13 review fix): each route call is aborted after
// UNIT_CODE_TIMEOUT_MS, so a slow or hung route never holds a creation that
// already landed; a door that creates many documents (the template filing)
// decodes them in ONE call per PER_CALL ids, not one call per document. When
// the call itself does not run, the route has nothing to record: the `note`
// is the only report (shown by the door that awaits it, logged by the one
// that does not), and the next unit-identity run places the document.

import { supabase } from "@/lib/supabase";

export type UnitCodeVia = "upload" | "split" | "merge" | "csv_import" | "renumber" | "renumber_reversed" | "metadata_edit";

export interface UnitCodeResult {
  documentId: string;
  unitCode: string | null;
  outcome: "decoded" | "unchanged" | "cleared" | "not_decoded" | "no_opinion" | "changed" | "refused" | "not_found";
  reason: string | null;
}

export interface UnitCodeAnswer {
  /** Per document, as the route answered (empty when the decode did not run). */
  results: UnitCodeResult[];
  /** A sentence for the caller's report when the decode did not run, or ran
   *  and left something undone (refused / changed under it). null: nothing
   *  to report. A number that simply does not decode is not an error — the
   *  route records its reason. Nor is "no opinion" (P13 third review fix):
   *  before 20261138 is pasted, or while the Site Codebook cannot decode a
   *  number, the route answers no results and no note, so no door holds a
   *  dialog for it. */
  note: string | null;
}

/** The route's per-call limit (lib/unitCodeDecode.ts DECODE_MAX_DOCUMENTS). */
const PER_CALL = 200;
/** How long one route call may take before it is abandoned (the decode is
 *  best-effort; the documents already exist). */
export const UNIT_CODE_TIMEOUT_MS = 15_000;
const LATER = "the next unit-identity run on Operational scope will place it";

export async function requestUnitCodeDecode(orgId: string, documentIds: string[], via: UnitCodeVia): Promise<UnitCodeAnswer> {
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (ids.length === 0 || !orgId || typeof window === "undefined") return { results: [], note: null };
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return { results: [], note: `The unit code was not decoded (not signed in) — ${LATER}.` };
    const results: UnitCodeResult[] = [];
    const notes: string[] = [];
    for (let i = 0; i < ids.length; i += PER_CALL) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), UNIT_CODE_TIMEOUT_MS);
      let res: Response;
      let body: { error?: string; results?: UnitCodeResult[]; notes?: string[] };
      try {
        res = await fetch("/api/documents/unit-code", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orgId, documentIds: ids.slice(i, i + PER_CALL), via }),
          signal: abort.signal,
        });
        body = (await res.json().catch(() => ({}))) as typeof body;
      } catch (e) {
        const why = abort.signal.aborted ? `no answer within ${UNIT_CODE_TIMEOUT_MS / 1000}s` : ((e as Error)?.message || "the request failed");
        notes.push(`The unit code of ${Math.min(PER_CALL, ids.length - i)} document(s) was not decoded (${why}) — ${LATER}.`);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        notes.push(`The unit code of ${Math.min(PER_CALL, ids.length - i)} document(s) was not decoded (${body.error || `HTTP ${res.status}`}) — ${LATER}.`);
        continue;
      }
      results.push(...(body.results ?? []));
      notes.push(...(body.notes ?? []));
    }
    const undone = results.filter((r) => r.outcome === "refused" || r.outcome === "changed");
    if (undone.length > 0) {
      notes.push(`The unit code of ${undone.length} document(s) was not written (${undone.map((r) => r.reason).filter(Boolean)[0] ?? "refused"}) — ${LATER}.`);
    }
    return { results, note: notes.length > 0 ? notes.join(" ") : null };
  } catch (e) {
    return { results: [], note: `The unit code was not decoded (${(e as Error)?.message || "the request failed"}) — ${LATER}.` };
  }
}
