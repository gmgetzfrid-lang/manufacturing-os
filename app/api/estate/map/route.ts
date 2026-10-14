// POST /api/estate/map — the Documents map's data, assembled server-side.
//
// The browser used to pull libraries, folders, thousands of documents,
// file facts, links and read copies itself, each query paying row-level
// security per row; "Reading the estate…" took fifteen seconds. The same
// loader run here with the service client, ACL applied by role, answers
// in a couple of seconds and ships one JSON body.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { loadFinderData } from "@/lib/fileFinder/load";
import type { Role } from "@/types/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const role = auth.caller!.role as Role;
  const controller = role === "Admin" || role === "DocCtrl";
  try {
    const d = await loadFinderData(orgId, role, controller, supabaseAdmin);
    return NextResponse.json({ ...d, folders: [...d.folders.entries()] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
