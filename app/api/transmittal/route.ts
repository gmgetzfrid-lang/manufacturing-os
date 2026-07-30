// /api/transmittal — the external side of a transmittal's portal link.
// Token possession is the whole credential (same contract as the project
// intake portal): the recipient has no account, sees ONLY this one
// transmittal, can download ONLY the files listed on it (at their as-sent
// revisions), and can acknowledge receipt once. Voided transmittals
// answer with their state; nothing else in the org is reachable.
//
//   GET  ?token=…                → the transmittal snapshot (no file URLs)
//   GET  ?token=…&file=<docId>   → short-lived signed URL for that item
//   POST { token, name, note? }  → recipient-side acknowledgment

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function loadByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const { data } = await supabaseAdmin
    .from("transmittals")
    .select("*")
    .eq("portal_token", token)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

type Item = { documentId?: string; number?: string; title?: string | null; rev?: string | null; versionId?: string | null };

/** Resolve an item's file: the exact version if pinned, else the version
 *  whose revision label matches the AS-SENT rev (never silently the newest —
 *  the portal must hand out what the transmittal says it carries). */
async function fileKeyForItem(item: Item): Promise<{ key: string; name: string } | null> {
  if (item.versionId) {
    const { data: v } = await supabaseAdmin
      .from("document_versions").select("file_url, revision_label")
      .eq("id", item.versionId).maybeSingle();
    if (v?.file_url) return { key: String(v.file_url), name: `${item.number ?? "document"}_Rev${v.revision_label ?? item.rev ?? ""}` };
  }
  if (item.documentId && item.rev) {
    const { data: v } = await supabaseAdmin
      .from("document_versions").select("file_url, created_at")
      .eq("record_id", item.documentId).eq("revision_label", item.rev)
      .order("created_at", { ascending: false }).limit(1);
    const hit = v?.[0];
    if (hit?.file_url) return { key: String(hit.file_url), name: `${item.number ?? "document"}_Rev${item.rev}` };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const t = await loadByToken(token);
  if (!t) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (t.status === "voided") return NextResponse.json({ error: "voided" }, { status: 410 });

  const fileDoc = req.nextUrl.searchParams.get("file");
  const items = (Array.isArray(t.items) ? t.items : []) as Item[];

  if (fileDoc) {
    const item = items.find((i) => i.documentId === fileDoc);
    if (!item) return bad("That document is not on this transmittal.", 403);
    const file = await fileKeyForItem(item);
    if (!file) return bad("The as-sent file for this document isn't available — contact the issuer.", 404);
    const url = await getSignedUrl(r2, new GetObjectCommand({
      Bucket: R2_BUCKET, Key: file.key,
      ResponseContentDisposition: `attachment; filename="${file.name.replace(/[^\w.\- ]+/g, "_")}"`,
    }), { expiresIn: 300 });
    await supabaseAdmin.from("audit_logs").insert({
      action: "TRANSMITTAL_PORTAL_DOWNLOAD",
      resource_type: "transmittal", resource_id: String(t.id),
      org_id: t.org_id, user_id: null, user_email: (t.recipient_email as string | null) ?? null,
      details: { number: t.number, documentId: fileDoc, docNumber: item.number, rev: item.rev },
    }).then(() => undefined, () => undefined);
    return NextResponse.json({ url });
  }

  // The snapshot the portal renders — nothing beyond this transmittal.
  const { data: org } = await supabaseAdmin.from("orgs").select("name").eq("id", t.org_id as string).maybeSingle();
  return NextResponse.json({
    number: t.number,
    subject: t.subject,
    purpose: t.purpose,
    status: t.status,
    notes: t.notes,
    orgName: (org?.name as string | null) ?? null,
    fromName: t.created_by_name,
    issuedAt: t.issued_at,
    acknowledgedAt: t.acknowledged_at,
    acknowledgedByName: t.acknowledged_by_name,
    recipientName: t.recipient_name,
    recipientCompany: t.recipient_company,
    items: items.map((i) => ({
      documentId: i.documentId, number: i.number, title: i.title ?? null, rev: i.rev ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: { token?: string; name?: string; note?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const token = String(body.token ?? "").trim();
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!name) return bad("Your name is required to acknowledge receipt.");

  const t = await loadByToken(token);
  if (!t) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (t.status === "voided") return bad("This transmittal was voided by the issuer.", 410);
  if (t.status === "acknowledged") {
    return NextResponse.json({ ok: true, already: true, acknowledgedByName: t.acknowledged_by_name, acknowledgedAt: t.acknowledged_at });
  }
  if (t.status !== "issued") return bad("This transmittal isn't in an acknowledgeable state.", 409);

  const now = new Date().toISOString();
  const meta = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    note: String(body.note ?? "").trim().slice(0, 500) || null,
  };
  const { error } = await supabaseAdmin
    .from("transmittals")
    .update({
      status: "acknowledged",
      acknowledged_at: now,
      acknowledged_by_name: name,
      acknowledged_via: "portal",
      acknowledged_meta: meta,
      updated_at: now,
    })
    .eq("id", t.id as string)
    .eq("status", "issued");
  if (error) return bad(`Couldn't record the acknowledgment: ${error.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "TRANSMITTAL_ACKNOWLEDGED",
    resource_type: "transmittal", resource_id: String(t.id),
    org_id: t.org_id, user_id: null, user_email: (t.recipient_email as string | null) ?? null,
    details: { number: t.number, acknowledgedBy: name, via: "portal", ...meta },
  }).then(() => undefined, () => undefined);

  // Tell the issuer their receipt landed.
  if (t.created_by) {
    await supabaseAdmin.from("notifications").insert({
      org_id: t.org_id, user_id: t.created_by,
      kind: "ack_complete",
      title: `Transmittal ${t.number} acknowledged`,
      body: `${name} confirmed receipt through the portal.`,
      link: "/transmittals",
      resource_type: "transmittal", resource_id: String(t.id),
      actor_name: name,
    }).then(() => undefined, () => undefined);
  }

  return NextResponse.json({ ok: true, acknowledgedAt: now });
}
