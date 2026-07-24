// GET /api/verify-hold?id=<uuid>
//
// The endpoint behind the QR on a printed HOLD card. Unauthenticated by
// design — a physical red tag hangs on equipment for weeks; anyone who sees
// it must be able to check "is this still active?" with a phone, no login.
// Exposure is minimal: hold status + reason + document label. The ID is an
// unguessable UUID that only exists on cards the org itself printed.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Verification unavailable" }, { status: 503 });
  }
  const holdId = req.nextUrl.searchParams.get("id") ?? "";
  if (!UUID_RE.test(holdId)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: hold } = await sb
    .from("document_holds")
    .select("id, document_id, reason, notes, opened_by_name, opened_at, released_at, released_by_name, released_reason")
    .eq("id", holdId)
    .maybeSingle();
  if (!hold) return NextResponse.json({ error: "Unknown hold" }, { status: 404 });

  const h = hold as Record<string, unknown>;
  let docLabel: string | null = null;
  let docRev: string | null = null;
  const { data: doc } = await sb
    .from("documents")
    .select("document_number, title, name, rev")
    .eq("id", String(h.document_id))
    .maybeSingle();
  if (doc) {
    const d = doc as Record<string, unknown>;
    docLabel = String(d.document_number || d.title || d.name || "");
    docRev = (d.rev as string | null) ?? null;
  }

  return NextResponse.json({
    active: !h.released_at,
    reason: (h.reason as string) ?? null,
    notes: (h.notes as string | null) ?? null,
    openedByName: (h.opened_by_name as string | null) ?? null,
    openedAt: (h.opened_at as string | null) ?? null,
    releasedAt: (h.released_at as string | null) ?? null,
    releasedByName: (h.released_by_name as string | null) ?? null,
    releasedReason: (h.released_reason as string | null) ?? null,
    docLabel,
    docRev,
    checkedAt: new Date().toISOString(),
  });
}
