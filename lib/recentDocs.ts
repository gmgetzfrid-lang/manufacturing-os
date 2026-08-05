// lib/recentDocs.ts — per-user recently viewed documents (cross-device).
//
// Recorded whenever a document opens (inspector select, viewer deep link);
// upsert keyed (user, document) so re-opening just bumps viewed_at. Powers
// the "Recently viewed" dashboard widget. Best-effort by design: a recents
// write must never break opening a document.

import { supabase } from "@/lib/supabase";

export function recordDocView(orgId: string, userId: string, documentId: string): void {
  void supabase.from("recently_viewed_docs")
    .upsert(
      { org_id: orgId, user_id: userId, document_id: documentId, viewed_at: new Date().toISOString() },
      { onConflict: "user_id,document_id" },
    )
    .then(() => undefined, () => undefined);
}

export interface RecentDoc {
  documentId: string;
  viewedAt: string;
  documentNumber: string | null;
  title: string | null;
  libraryId: string;
  rev: string | null;
  status: string | null;
}

export async function listRecentDocs(userId: string, limit = 8): Promise<RecentDoc[]> {
  const { data, error } = await supabase
    .from("recently_viewed_docs")
    .select("document_id, viewed_at")
    .eq("user_id", userId)
    .order("viewed_at", { ascending: false })
    .limit(limit);
  if (error || !data || data.length === 0) return [];
  const ids = (data as Array<{ document_id: string }>).map((r) => r.document_id);
  const { data: docs } = await supabase
    .from("documents").select("id, document_number, title, library_id, rev, status")
    .in("id", ids);
  const byId = new Map((docs ?? []).map((d) => [(d as { id: string }).id, d as Record<string, unknown>]));
  return (data as Array<{ document_id: string; viewed_at: string }>)
    .map((r) => {
      const d = byId.get(r.document_id);
      if (!d) return null;
      return {
        documentId: r.document_id,
        viewedAt: r.viewed_at,
        documentNumber: (d.document_number as string | null) ?? null,
        title: (d.title as string | null) ?? null,
        libraryId: d.library_id as string,
        rev: (d.rev as string | null) ?? null,
        status: (d.status as string | null) ?? null,
      };
    })
    .filter((x): x is RecentDoc => x !== null);
}
