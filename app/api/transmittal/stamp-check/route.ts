// /api/transmittal/stamp-check — document-control TRX-16: the issue-time
// stampability check.
//
// Before a draft transmittal is issued, the issue flow (lib/transmittals.ts
// issueTransmittal) asks whether the recipient's portal will be able to
// stamp each file — a size bound plus a pdf-lib load of the file the issue
// will pin (lib/transmittalStampCheck.ts) — so the ISSUER is warned at
// issue, not the recipient at download. Done here, where the files are, so
// the browser never fetches them.
//
// Who may ask: the caller proves a session, and must be an ACTIVE member of
// the transmittal's workspace holding transmit authority for every document
// on it (TRX-1, `transmittal.issue` per item library — the people who can
// issue it). Only a DRAFT is checked (an issued transmittal's files are what
// was sent). Read-only: nothing is written, and the answer carries each
// item's verdict (and why), never file content.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { evaluateTransmitAuthority, rowToTransmittal } from "@/lib/transmittals";
import { checkItemsStampable } from "@/lib/transmittalStampCheck";

export const runtime = "nodejs";
// The check reads each file once (up to the portal's stamping bound) within
// its own time budget (STAMP_CHECK_TIME_BUDGET_MS); this is the ceiling.
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { transmittalId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const transmittalId = String(body.transmittalId ?? "").trim();
  if (!transmittalId) return bad("transmittalId is required");

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("transmittals").select("*").eq("id", transmittalId).maybeSingle();
  if (rowErr) return bad(`Couldn't load the transmittal: ${rowErr.message}`, 500);
  if (!row) return bad("Transmittal not found.", 404);
  const t = rowToTransmittal(row as Record<string, unknown>);

  const authority = await evaluateTransmitAuthority(supabaseAdmin, { orgId: t.orgId, uid: user.id, items: t.items });
  if (authority.error) return bad(authority.error, 503);
  // Not a member: answer as if the transmittal did not exist (no oracle).
  if (!authority.member) return bad("Transmittal not found.", 404);
  if (!authority.allowed) {
    return bad("Only a transmit authority (the \"Issue transmittals\" capability) can check a transmittal before issuing it.", 403);
  }
  if (t.status !== "draft") return bad(`${t.number} is ${t.status} — only a draft is checked before issue.`, 409);

  const items = await checkItemsStampable(supabaseAdmin, { orgId: t.orgId, items: t.items });
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
