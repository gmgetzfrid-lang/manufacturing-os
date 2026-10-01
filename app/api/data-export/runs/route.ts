// GET /api/data-export/runs?orgId=...&limit=50
//
// History of every export run. Hydrated with the destination name when
// applicable so the UI can show "Acme Cold Storage — succeeded — 12 MB".
// Admin-only, like every data-export route (admin-and-org BKP-8), through
// the one gate (lib/adminGate.ts).

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";

type ExportRunRow = { destination_id?: string | null } & Record<string, unknown>;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: runs } = await auth.admin
    .from("export_runs")
    .select("*")
    .eq("org_id", orgId)
    .order("started_at", { ascending: false })
    .limit(limit);

  // Hydrate destination names so the UI doesn't have to join
  const destIds = Array.from(new Set(((runs ?? []) as ExportRunRow[]).map((r) => r.destination_id).filter(Boolean)));
  const destMap = new Map<string, string>();
  if (destIds.length > 0) {
    const { data: dests } = await auth.admin
      .from("export_destinations")
      .select("id, name, destination_type")
      .in("id", destIds);
    for (const d of (dests ?? []) as Array<{ id: string; name: string }>) {
      destMap.set(d.id, d.name);
    }
  }

  const enriched = ((runs ?? []) as ExportRunRow[]).map((r) => ({
    ...r,
    destination_name: r.destination_id ? destMap.get(r.destination_id) ?? "(deleted)" : "Direct download",
  }));

  return NextResponse.json({ runs: enriched });
}
