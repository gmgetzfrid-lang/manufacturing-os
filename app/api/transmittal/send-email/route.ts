// /api/transmittal/send-email — SURF-17: the transmittal recipient email is
// queued SERVER-SIDE, rendered from the transmittal ROW, by the service role.
//
// Before, the browser rendered subject/body from a client-held object and
// inserted straight into email_notifications with metadata.external = true —
// the one member-reachable path to mail an arbitrary address with arbitrary
// HTML. Migration 20261047 closes that door at the database (a client INSERT
// must address a same-org member and may not be external); this route is
// the legitimate external path: the caller proves a session, must be an
// active member of the transmittal's org holding transmit authority for it
// (TRX-1: the `transmittal.issue` capability per item library — the role
// list this route hardcoded is now the capability's default, DEC-35), and
// the message is rebuilt from the row — never from the body.
//
// TRX-14 / XEDGE-5: the link is built on the PUBLIC origin. On the server
// with NEXT_PUBLIC_SITE_URL unset there is none, and a hostless
// `/transmittal/<token>` is never emailed — the route answers sent: false
// with the reason, and the issue flow says so.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  evaluateTransmitAuthority, portalLinkState, renderTransmittalEmail, rowToTransmittal, transmittalPortalUrl,
} from "@/lib/transmittals";

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

  // Authority (TRX-1): an active member of the transmittal's org holding
  // transmit authority for every document on it. Fails closed when the
  // policy cannot be read.
  const authority = await evaluateTransmitAuthority(supabaseAdmin, { orgId: t.orgId, uid: user.id, items: t.items });
  if (authority.error) return bad(authority.error, 503);
  const member = authority.member;
  if (!member) return bad("Not an active member of this workspace.", 403);
  if (!authority.allowed) {
    return bad("Only a transmit authority (the \"Issue transmittals\" capability) can email this transmittal.", 403);
  }

  const to = t.recipientEmail?.trim();
  const link = portalLinkState(t);
  if (!to || !t.portalToken || link !== "live") {
    return NextResponse.json({
      ok: false, sent: false,
      reason: !to ? "no recipient email" : !t.portalToken ? "no portal token" : `the portal link is ${link}`,
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return bad(`"${to}" doesn't look like an email address.`);

  // TRX-14: never email a hostless link.
  const portalUrl = transmittalPortalUrl(t.portalToken);
  if (!portalUrl) {
    console.error("[transmittal/send-email] NEXT_PUBLIC_SITE_URL is not set — refusing to email a hostless portal link", { transmittal: t.id });
    return NextResponse.json({ ok: false, sent: false, reason: "this deployment has no public site URL (NEXT_PUBLIC_SITE_URL), so no portal link can be emailed" });
  }

  // Rendered from the ROW — the body of this request carries nothing but an id.
  const { subject, text, html } = renderTransmittalEmail(t, portalUrl);
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
