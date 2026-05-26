// GET /api/data-export/runs?orgId=...&limit=50
//
// History of every export run. Hydrated with the destination name when
// applicable so the UI can show "Acme Cold Storage — succeeded — 12 MB".

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: runs } = await auth.admin
    .from("export_runs")
    .select("*")
    .eq("org_id", orgId)
    .order("started_at", { ascending: false })
    .limit(limit);

  // Hydrate destination names so the UI doesn't have to join
  const destIds = Array.from(new Set(((runs ?? []) as any[]).map((r) => r.destination_id).filter(Boolean)));
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

  const enriched = ((runs ?? []) as any[]).map((r) => ({
    ...r,
    destination_name: r.destination_id ? destMap.get(r.destination_id) ?? "(deleted)" : "Direct download",
  }));

  return NextResponse.json({ runs: enriched });
}
