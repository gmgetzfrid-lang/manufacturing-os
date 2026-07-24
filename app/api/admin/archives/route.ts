// GET /api/admin/archives?orgId= — the offline-archive catalog, with live
// commit state. This is the recovery view for the two-step space saver: a
// produce that was downloaded but never committed (tab closed, crash) is
// otherwise invisible — its rows stay claimed, its space never reclaimed.
// Listing the catalog with per-archive pending counts gives the admin a
// Commit/Discard handle for every archive ever produced.
//
//   status "producing" — produce crashed mid-bundle; only Discard is safe
//   status "pending"   — produced + downloaded, cloud bytes NOT yet freed
//   status "committed" — reclaimed; the zip is the only copy of those bytes
//   (kind "full" rows are full-backup records — informational)

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";

export const runtime = "nodejs";

const ROLES = ["Admin", "DocCtrl"];

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  const { data: rows, error } = await sb
    .from("archives")
    .select("archive_id, kind, file_count, total_bytes, note, created_at, created_by_email")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const list = (rows ?? []) as Array<{
    archive_id: string; kind: string | null; file_count: number | null; total_bytes: number | null;
    note: string | null; created_at: string | null; created_by_email: string | null;
  }>;
  const ids = list.map((r) => r.archive_id);

  // Live claim/commit state per archive, from both shed targets.
  const docState = new Map<string, { pending: number; committed: number }>();
  const ticketState = new Map<string, { pending: number; committed: number }>();
  if (ids.length > 0) {
    const { data: vers } = await sb
      .from("document_versions")
      .select("archive_id, archived_at")
      .eq("org_id", orgId)
      .in("archive_id", ids);
    for (const v of ((vers ?? []) as Array<{ archive_id: string; archived_at: string | null }>)) {
      const s = docState.get(v.archive_id) ?? { pending: 0, committed: 0 };
      if (v.archived_at) s.committed++; else s.pending++;
      docState.set(v.archive_id, s);
    }
    const { data: tks } = await sb
      .from("tickets")
      .select("archive_id, archived_at")
      .eq("org_id", orgId)
      .in("archive_id", ids);
    for (const t of ((tks ?? []) as Array<{ archive_id: string; archived_at: string | null }>)) {
      const s = ticketState.get(t.archive_id) ?? { pending: 0, committed: 0 };
      if (t.archived_at) s.committed++; else s.pending++;
      ticketState.set(t.archive_id, s);
    }
  }

  const { data: st } = await sb
    .from("archive_settings").select("location_hint")
    .eq("org_id", orgId).maybeSingle();
  const root = (st as { location_hint?: string | null } | null)?.location_hint ?? null;

  const archives = list.map((r) => {
    const d = docState.get(r.archive_id) ?? { pending: 0, committed: 0 };
    const t = ticketState.get(r.archive_id) ?? { pending: 0, committed: 0 };
    const producing = (r.note ?? "") === "producing…";
    const pending = d.pending + t.pending;
    const committed = d.committed + t.committed;
    const status = r.kind === "full"
      ? "full"
      : producing ? "producing"
      : pending > 0 ? "pending"
      : committed > 0 ? "committed"
      : "empty";
    return {
      archiveId: r.archive_id,
      kind: r.kind ?? "space",
      fileCount: r.file_count ?? 0,
      totalBytes: r.total_bytes ?? 0,
      note: r.note ?? "",
      createdAt: r.created_at,
      createdByEmail: r.created_by_email,
      docPending: d.pending, docCommitted: d.committed,
      ticketPending: t.pending, ticketCommitted: t.committed,
      status,
    };
  });

  return NextResponse.json({ root, archives });
}
