// POST /api/estate/resolve — run the resolver over folders / documents / a
// library / everything. Document control only (it writes edges). Returns
// what was applied, what waits in Review, and what was already known.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { resolveEstate } from "@/lib/estate/resolverServer";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; folderIds?: string[]; documentIds?: string[]; libraryIds?: string[]; all?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl", "Manager", "Supervisor"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    const result = await resolveEstate(supabaseAdmin, {
      orgId,
      folderIds: Array.isArray(body.folderIds) ? body.folderIds.map(String) : undefined,
      documentIds: Array.isArray(body.documentIds) ? body.documentIds.map(String) : undefined,
      libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : undefined,
      all: !!body.all,
      actor: { userId: auth.caller!.userId, name: auth.caller!.email },
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
