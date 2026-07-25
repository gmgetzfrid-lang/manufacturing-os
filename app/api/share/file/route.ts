// GET /api/share/file?token=<share token>
//
// Streams the shared document's current published file, stamped SERVER-SIDE
// (uncontrolled watermark, rev footer, verify QR) before a single byte leaves.
//
// Why server-side: the old flow handed the browser a raw presigned R2 URL and
// stamped client-side with fetch() — but the bucket carries no CORS
// configuration, so that fetch failed on every cross-origin download and the
// page's fallback opened the RAW UNSTAMPED file in a new tab. The copy-leak
// protection silently never applied to the one audience it matters most for:
// outsiders. Here the bytes are pulled bucket→server (no CORS in play) and
// stamped with the same applyStampToPdfDoc as internal downloads.
//
// Auth: possession of the unguessable token, exactly like /api/share/resolve.
// The download_audits row is written HERE (an actual download), while resolve
// keeps the access-counter bump (link opened).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { PDFDocument } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";

export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Share downloads unavailable" }, { status: 503 });
  }
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: share } = await sb
    .from("document_shares")
    .select("id, org_id, document_id, expires_at, revoked_at, created_by")
    .eq("token", token)
    .maybeSingle();
  if (!share) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (share.revoked_at) return NextResponse.json({ error: "revoked" }, { status: 410 });
  if (share.expires_at && new Date(share.expires_at as string).getTime() < Date.now()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const { data: doc } = await sb
    .from("documents")
    .select("id, document_number, title, name, rev, current_version_id")
    .eq("id", share.document_id as string)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "notfound" }, { status: 404 });

  // Resolve the current PUBLISHED version's file (never an in-review draft) —
  // same resolution order as /api/share/resolve.
  let storagePath: string | null = null;
  let versionId: string | null = (doc.current_version_id as string | null) ?? null;
  if (versionId) {
    const { data: v } = await sb.from("document_versions").select("file_url").eq("id", versionId).maybeSingle();
    storagePath = (v?.file_url as string | null) ?? null;
  }
  if (!storagePath) {
    const { data: latest } = await sb
      .from("document_versions")
      .select("id, file_url")
      .eq("record_id", doc.id as string)
      .or("review_state.is.null,review_state.eq.approved")
      .order("created_at", { ascending: false })
      .limit(1);
    if (latest?.length) {
      storagePath = (latest[0] as { file_url: string }).file_url;
      versionId = (latest[0] as { id: string }).id;
    }
  }
  if (!storagePath) return NextResponse.json({ error: "nofile" }, { status: 404 });

  // Pull the bytes server-side — an absolute URL (legacy rows) via fetch, a
  // storage key straight from the bucket. No CORS on either path.
  let source: Uint8Array;
  try {
    if (/^https?:\/\//i.test(storagePath)) {
      const res = await fetch(storagePath);
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      source = new Uint8Array(await res.arrayBuffer());
    } else {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: storagePath }));
      const bytes = await obj.Body?.transformToByteArray();
      if (!bytes) throw new Error("empty object body");
      source = bytes;
    }
  } catch (e) {
    console.warn("[share/file] file fetch failed", (e as Error).message);
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }

  const label = String(doc.document_number || doc.title || doc.name || "document");
  const rev = (doc.rev as string | null) ?? null;

  let outBytes: Uint8Array = source;
  let stamped = false;
  try {
    const pdfDoc = await PDFDocument.load(source);
    await applyStampToPdfDoc(pdfDoc, {
      userLabel: "shared-link",
      timestamp: new Date(),
      watermarkText: "UNCONTROLLED — SHARED COPY",
      footerNotice: `${label} Rev ${rev ?? "?"} at time of download — scan the QR to confirm it is still current.`,
      verifyUrl: versionId && publicOrigin()
        ? `${publicOrigin()}/verify/${doc.id as string}?v=${versionId}`
        : undefined,
    });
    outBytes = await pdfDoc.save();
    stamped = true;
  } catch (e) {
    // Not a stampable PDF (encrypted / corrupt / scanned oddity). Deliver it
    // anyway — but through this route, never a raw bucket URL, and the audit
    // row below records that it went out unmarked.
    console.warn("[share/file] stamping failed — delivering unstamped", (e as Error).message);
  }

  // The distribution record: this is the actual download (resolve only counts
  // the link being opened).
  try {
    await sb.from("download_audits").insert({
      org_id: share.org_id,
      document_id: doc.id,
      version_id: versionId,
      user_id: (share.created_by as string | null) ?? null, // attributed to the sharer — the outsider has no account
      user_email: null,
      created_at: new Date().toISOString(),
      expires_at: (share.expires_at as string | null) ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
      watermark_policy_id: null,
      source: stamped ? "share_link" : "share_link_unstamped",
    });
  } catch { /* pre-migration column drift — never block the share */ }

  const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
  const filename = `${safe(label)}_Rev${safe(rev ?? "0")}.pdf`;
  return new NextResponse(Buffer.from(outBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
