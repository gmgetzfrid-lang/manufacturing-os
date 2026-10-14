// POST /api/find — the one find service. Any active member; access is
// enforced per document inside. Body: { orgId, query, scope?, limit?, activity? }.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { findEstate } from "@/lib/find/server";
import type { FindRequest } from "@/lib/find/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: Partial<FindRequest>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const principal = await loadPrincipal(orgId, auth.caller!.userId);
  if (!principal) return NextResponse.json({ error: "Not a member" }, { status: 403 });
  try {
    const out = await findEstate(supabaseAdmin, principal, {
      orgId, query: String(body.query ?? ""), scope: body.scope, limit: body.limit, activity: body.activity,
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
