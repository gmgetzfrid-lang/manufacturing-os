// POST /api/estate/watchdog — "do these look like they belong elsewhere?"
// Body: { orgId, documentIds?, folderIds? }. Returns one suggestion per
// target that has a better home, with the reason. Read-only.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { loadResolveContext } from "@/lib/estate/resolverServer";
import { suggestHome, type HomeFolder, type HomeSuggestion } from "@/lib/estate/watchdog";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; documentIds?: string[]; folderIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    const ctx = await loadResolveContext(supabaseAdmin, orgId);
    const { data: libs } = await supabaseAdmin.from("libraries").select("id, name").eq("org_id", orgId);
    const libName = new Map(((libs as Array<{ id: string; name: string }> | null) ?? []).map((l) => [l.id, l.name]));
    const chainOf = (id: string | null): { names: string[]; ids: string[] } => {
      const names: string[] = [], ids: string[] = []; const seen = new Set<string>(); let cur = id;
      while (cur && !seen.has(cur)) { seen.add(cur); const f = ctx.folders.get(cur); if (!f) break; names.unshift(f.name); ids.unshift(f.id); cur = f.parentId; }
      return { names, ids };
    };
    const homes: HomeFolder[] = [...ctx.folders.values()].map((f) => {
      const c = chainOf(f.id);
      let unitCode: string | undefined;
      for (let i = c.ids.length - 1; i >= 0 && !unitCode; i--) unitCode = ctx.folderUnits?.get(c.ids[i]);
      return { id: f.id, libraryId: f.libraryId, libraryName: libName.get(f.libraryId) ?? "Library", chain: c.names, chainIds: c.ids, unitCode };
    });
    const out: HomeSuggestion[] = [];
    if (body.documentIds?.length) {
      const { data } = await supabaseAdmin.from("documents").select("id, name, document_number, collection_id, library_id").eq("org_id", orgId).in("id", body.documentIds.slice(0, 200));
      for (const d of (data as Array<{ id: string; name: string | null; document_number: string | null; collection_id: string | null; library_id: string }> | null) ?? []) {
        const s = suggestHome({ kind: "document", id: d.id, name: d.name || d.document_number || "", documentNumber: d.document_number, pathIds: chainOf(d.collection_id).ids, libraryId: d.library_id }, homes, ctx);
        if (s && !s.alreadyHome) out.push(s);
      }
    }
    for (const fid of (body.folderIds ?? []).slice(0, 50)) {
      const f = ctx.folders.get(fid);
      if (!f) continue;
      const s = suggestHome({ kind: "folder", id: f.id, name: f.name, pathIds: chainOf(f.parentId).ids, libraryId: f.libraryId }, homes, ctx);
      if (s && !s.alreadyHome) out.push(s);
    }
    return NextResponse.json({ suggestions: out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
