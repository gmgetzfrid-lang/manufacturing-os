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
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import type { Role } from "@/types/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const principal = await loadPrincipal(orgId, auth.caller!.userId);
  if (!principal) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  const role = principal.role as Role;
  const controller = principal.isController;
  try {
    const d = await loadFinderData(orgId, role, controller, supabaseAdmin);
    // The service client sees everything; the person must not. Same
    // per-document engine as search and Ask: restricted, held-back and
    // team-only documents drop out here, before anything leaves the server.
    if (!controller) {
      const readable = await readableControlledDocIds(principal, d.entries.map((e) => e.id.replace(/^doc:/, "")));
      d.entries = d.entries.filter((e) => readable.has(e.id.replace(/^doc:/, "")));
      const keep = new Set(d.entries.map((e) => e.id));
      d.edges = d.edges.filter((e) => !e.a.startsWith("doc:") || keep.has(e.a));
    }
    return NextResponse.json({ ...d, folders: [...d.folders.entries()] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
