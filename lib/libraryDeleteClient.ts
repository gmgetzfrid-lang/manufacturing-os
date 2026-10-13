// lib/libraryDeleteClient.ts — CLIENT-side caller of the library delete route.
//
// admin-and-org ALOG-3 (Round G, P8): every app door that deletes a library
// (/admin/libraries and the library tile menu on /documents) goes through
// POST /api/admin/libraries/delete — it counts what the cascade removes,
// refuses when it cannot count, deletes AS THE CALLER and records
// LIBRARY_DELETED. This is the one fetch both pages use, so neither can drift
// back to a direct browser delete.

import { supabase } from "@/lib/supabase";

export interface LibraryDeleteResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export async function postLibraryDelete(body: Record<string, unknown>): Promise<LibraryDeleteResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/api/admin/libraries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* a body that is not JSON is said by the status */ }
  return { ok: res.ok, status: res.status, body: json };
}

/** The route's sentence for a refused call, or the status when it gave none. */
export function libraryDeleteError(r: LibraryDeleteResponse, fallback: string): string {
  return typeof r.body.error === "string" && r.body.error ? r.body.error : `${fallback} (HTTP ${r.status}).`;
}
