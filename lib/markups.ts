// lib/markups.ts
//
// GAP-7 / DEC-24: viewer markup as a durable, addressable artifact. The
// viewer already produces normalized per-page fabric JSON (scale 1.0, keyed by
// 1-based page number — the shape lib/markupExport bakes); this module keeps
// it SERVER-SIDE, one row per (document, version, user), saved as the user
// works and restored when the sheet is reopened. The baked PDF is a derivative
// of the stored state, never the only copy. Browser-local storage is not the
// source of truth for anything here.

import { supabase } from "@/lib/supabase";

export interface DocumentMarkup {
  id: string;
  orgId: string;
  documentId: string;
  versionId: string;
  userId: string;
  userName?: string | null;
  checkoutSessionId: string | null;
  pageStates: Record<number, object>;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export const MARKUP_CONFLICT = "document_id,version_id,user_id";

function rowTo(r: Record<string, unknown>): DocumentMarkup {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    documentId: String(r.document_id),
    versionId: String(r.version_id),
    userId: String(r.user_id),
    checkoutSessionId: (r.checkout_session_id as string | null) ?? null,
    pageStates: (r.page_states as Record<number, object> | null) ?? {},
    pageCount: typeof r.page_count === "number" ? r.page_count : 0,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

/** Pre-migration tolerance: the table is added by 20261051. Until it exists
 *  the viewer must keep working — reads are empty, writes are reported. */
export function isMissingMarkupSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = String(e?.message ?? "");
  return e?.code === "42P01" || e?.code === "PGRST205" || /document_markups/.test(msg) && /does not exist|not find|schema cache/i.test(msg);
}

/** Pages that carry at least one object. */
export function markedPages(states: Record<number, object> | null | undefined): number[] {
  const out: number[] = [];
  for (const [k, v] of Object.entries(states ?? {})) {
    const objs = (v as { objects?: unknown[] } | null)?.objects;
    if (Array.isArray(objs) && objs.length > 0) out.push(Number(k));
  }
  return out.sort((a, b) => a - b);
}

export function isEmptyMarkup(states: Record<number, object> | null | undefined): boolean {
  return markedPages(states).length === 0;
}

/** The caller's own markup for this document version, or null. */
export async function loadMyMarkup(documentId: string, versionId: string, uid: string): Promise<DocumentMarkup | null> {
  const { data, error } = await supabase
    .from("document_markups").select("*")
    .eq("document_id", documentId).eq("version_id", versionId).eq("user_id", uid)
    .maybeSingle();
  if (error) {
    if (isMissingMarkupSchema(error)) return null;
    throw new Error(error.message);
  }
  return data ? rowTo(data as Record<string, unknown>) : null;
}

/** The caller's active checkout session on this document, for provenance. */
export async function myActiveSessionId(documentId: string, uid: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("checkout_sessions").select("id")
      .eq("document_id", documentId).eq("user_id", uid).eq("status", "active")
      .limit(1).maybeSingle();
    return ((data as { id?: string } | null)?.id) ?? null;
  } catch { return null; }
}

/** Save the caller's markup (last write wins per user per version). A markup
 *  with nothing drawn on any page removes the row rather than leaving a ghost.
 *  Returns the stored row, or null when nothing is stored. A refused or failed
 *  write throws — it is never reported as saved. */
export async function saveMyMarkup(input: {
  orgId: string; documentId: string; versionId: string; uid: string;
  checkoutSessionId?: string | null; pageStates: Record<number, object>;
}): Promise<DocumentMarkup | null> {
  const pages = markedPages(input.pageStates);
  if (pages.length === 0) {
    const { error } = await supabase.from("document_markups").delete()
      .eq("document_id", input.documentId).eq("version_id", input.versionId).eq("user_id", input.uid);
    if (error && !isMissingMarkupSchema(error)) throw new Error(error.message);
    return null;
  }
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("document_markups")
    .upsert({
      org_id: input.orgId, document_id: input.documentId, version_id: input.versionId, user_id: input.uid,
      checkout_session_id: input.checkoutSessionId ?? null,
      page_states: input.pageStates, page_count: pages.length, updated_at: now,
    }, { onConflict: MARKUP_CONFLICT })
    .select("*")
    .single();
  if (error) {
    if (isMissingMarkupSchema(error)) { console.warn("[markups] store not installed yet (20261051) — markup not persisted"); return null; }
    throw new Error(error.message);
  }
  return rowTo(data as Record<string, unknown>);
}

/** Every markup on a document (all versions, all authors), newest first, with
 *  author names — what the register's inspector lists so a markup is
 *  discoverable without anyone having downloaded anything. */
export async function listMarkupsForDocument(documentId: string): Promise<DocumentMarkup[]> {
  const { data, error } = await supabase
    .from("document_markups").select("*")
    .eq("document_id", documentId)
    .order("updated_at", { ascending: false });
  if (error) {
    if (isMissingMarkupSchema(error)) return [];
    throw new Error(error.message);
  }
  const rows = ((data as Array<Record<string, unknown>>) ?? []).map(rowTo);
  const uids = [...new Set(rows.map((r) => r.userId))];
  if (uids.length > 0) {
    const { data: members } = await supabase.from("org_members").select("uid, display_name, email").in("uid", uids);
    const names = new Map<string, string>();
    for (const m of (members as Array<{ uid: string; display_name: string | null; email: string | null }> | null) ?? []) {
      names.set(m.uid, (m.display_name || "").trim() || (m.email || "").split("@")[0] || "member");
    }
    for (const r of rows) r.userName = names.get(r.userId) ?? null;
  }
  return rows;
}
