// /api/transmittal/receipt — TRX-6: a receipt recorded on the register (a
// signed cover sheet came back, the recipient confirmed by phone).
//
// The receipt columns (acknowledged_*) are written once, on the issued →
// acknowledged transition, and never by a member session: trg_transmittals_
// guard (20261133) refuses that write from any signed-in caller, so a creator
// can no longer manufacture their own recipient's receipt. This route is the
// register's legitimate path: the caller proves a session, must be an ACTIVE
// member holding transmit authority for every document on the transmittal
// (TRX-1, the `transmittal.issue` capability per item library), and the
// service role writes the receipt with WHO recorded it in acknowledged_meta —
// so a receipt typed in by an org member never reads like the recipient's
// own portal acknowledgment (TRX-13). The audit row is written by the server.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { evaluateTransmitAuthority, rowToTransmittal } from "@/lib/transmittals";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { transmittalId?: string; name?: string; note?: string | null };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const transmittalId = String(body.transmittalId ?? "").trim();
  const name = String(body.name ?? "").trim().slice(0, 120);
  const note = String(body.note ?? "").trim().slice(0, 500) || null;
  if (!transmittalId) return bad("transmittalId is required");
  if (!name) return bad("Name the person who acknowledged receipt.");

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("transmittals").select("*").eq("id", transmittalId).maybeSingle();
  if (rowErr) return bad(`Couldn't load the transmittal: ${rowErr.message}`, 500);
  if (!row) return bad("Transmittal not found.", 404);
  const t = rowToTransmittal(row as Record<string, unknown>);

  const authority = await evaluateTransmitAuthority(supabaseAdmin, { orgId: t.orgId, uid: user.id, items: t.items });
  if (authority.error) return bad(authority.error, 503);
  if (!authority.member) return bad("Not an active member of this workspace.", 403);
  if (!authority.allowed) {
    return bad("Only a transmit authority (the \"Issue transmittals\" capability) can record a receipt on the recipient's behalf.", 403);
  }
  if (t.status === "acknowledged") return bad(`${t.number} is already acknowledged.`, 409);
  if (t.status !== "issued") return bad(`${t.number} is ${t.status} — only an issued transmittal can be acknowledged.`, 409);

  const now = new Date().toISOString();
  const meta = { recordedBy: user.id, recordedByEmail: authority.member.email ?? user.email ?? null, note };
  const { data: updated, error } = await supabaseAdmin
    .from("transmittals")
    .update({
      status: "acknowledged",
      acknowledged_at: now,
      acknowledged_by_name: name,
      acknowledged_via: "manual",
      acknowledged_meta: meta,
      updated_at: now,
    })
    .eq("id", t.id)
    .eq("status", "issued")
    .select("id");
  if (error) return bad(`Couldn't record the receipt: ${error.message}`, 500);
  if (!updated || updated.length === 0) return bad(`${t.number} is no longer awaiting a receipt.`, 409);

  const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
    action: "TRANSMITTAL_ACKNOWLEDGED",
    resource_type: "transmittal", resource_id: t.id, org_id: t.orgId,
    user_id: user.id, user_email: meta.recordedByEmail,
    details: { number: t.number, acknowledgedBy: name, via: "manual", note },
  });
  if (auditError) console.error("[transmittal/receipt] audit row refused — the receipt stands", { transmittal: t.id, message: auditError.message });

  return NextResponse.json({ ok: true, acknowledgedAt: now, auditRecorded: !auditError });
}
