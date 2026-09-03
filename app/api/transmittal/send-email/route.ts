// /api/transmittal/send-email — SURF-17: the transmittal recipient email is
// queued SERVER-SIDE, rendered from the transmittal ROW, by the service role.
//
// Before, the browser rendered subject/body from a client-held object and
// inserted straight into email_notifications with metadata.external = true —
// the one member-reachable path to mail an arbitrary address with arbitrary
// HTML. Migration 20261047 closes that door at the database (a client INSERT
// must address a same-org member and may not be external); this route is
// the legitimate external path: the caller proves a session, must be an
// active member of the transmittal's org and either its issuer or a
// controller, and the message is rebuilt from the row — never from the body.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { renderTransmittalEmail, rowToTransmittal, transmittalPortalUrl } from "@/lib/transmittals";

export const runtime = "nodejs";

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

  // Authority: an active member of the transmittal's org who issued it, or a
  // controller by the role collection.
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles, email")
    .eq("org_id", t.orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Not an active member of this workspace.", 403);
  const held = new Set<string>([(member.role as string) || "", ...(((member.roles as string[] | null) ?? []))]);
  const isController = held.has("Admin") || held.has("DocCtrl");
  if (t.createdBy !== user.id && !isController) {
    return bad("Only the transmittal's issuer or a Document Controller can email it.", 403);
  }

  const to = t.recipientEmail?.trim();
  if (!to || !t.portalToken || t.status === "voided") {
    return NextResponse.json({ ok: false, sent: false, reason: !to ? "no recipient email" : !t.portalToken ? "no portal token" : "voided" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return bad(`"${to}" doesn't look like an email address.`);

  // Rendered from the ROW — the body of this request carries nothing but an id.
  const { subject, text, html } = renderTransmittalEmail(t, transmittalPortalUrl(t.portalToken));
  const { error: qErr } = await supabaseAdmin.from("email_notifications").insert({
    org_id: t.orgId,
    to_user_id: user.id,
    to_email: to,
    subject,
    body_text: text,
    body_html: html,
    resource_type: null,
    resource_id: t.id,
    event_type: "transmittal_issued",
    metadata: { number: t.number, purpose: t.purpose, external: true, sentVia: "server" },
    status: "queued",
  });
  if (qErr) return bad(`Couldn't queue the email: ${qErr.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "TRANSMITTAL_EMAILED",
    resource_type: "transmittal", resource_id: t.id, org_id: t.orgId,
    user_id: user.id, user_email: (member.email as string | null) ?? user.email ?? null,
    details: { number: t.number, to, via: "server" },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, sent: true });
}
