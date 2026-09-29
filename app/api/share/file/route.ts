// GET /api/share/file?token=<share token>
//
// Streams the shared document's CURRENT published file, stamped SERVER-SIDE
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
// Auth: possession of the unguessable token, exactly like /api/share/resolve
// — and the SAME decision (lib/shareServe.ts): org-joined document, the
// creator's current authority, a Draft / Superseded / Void / Archived or
// HELD document refused with the reason, and a version that is published,
// not a branch, not superseded.
//
// The distribution record: the download_audits row is written HERE, before
// the bytes go, attributed to the SHARE (share_id, user_id NULL, source —
// DEC-44 §1) so recall can tell an outside holder from the sharer. It is
// checked and FAILS CLOSED: a controlled copy does not leave the building
// unrecorded (DIST-7 / EGR-3 / SHR-5 / PHYS-8).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { PDFDocument } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";
import { recordShareAccess, requestMeta, resolveShareForServing, servedLabels, shareFooterNotice } from "@/lib/shareServe";

export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Share downloads unavailable" }, { status: 503 });
  }
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const resolved = await resolveShareForServing(sb, token);
  if (!resolved.ok) return NextResponse.json(resolved.body, { status: resolved.status });
  const { share, doc, version } = resolved;
  if (!version) return NextResponse.json({ error: "nofile" }, { status: 404 });

  // Pull the bytes server-side — an absolute URL (legacy rows) via fetch, a
  // storage key straight from the bucket. No CORS on either path.
  const storagePath = version.storagePath;
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

  // The revision printed on the copy is the SERVED version's own label (SHR-7).
  const { label, rev } = servedLabels(doc, version);
  const origin = publicOrigin();
  const verifyUrl = origin ? `${origin}/verify/${doc.id}?v=${version.id}` : undefined;

  let outBytes: Uint8Array = source;
  let stamped = false;
  try {
    const pdfDoc = await PDFDocument.load(source);
    await applyStampToPdfDoc(pdfDoc, {
      userLabel: "shared-link",
      timestamp: new Date(),
      watermarkText: "UNCONTROLLED — SHARED COPY",
      footerNotice: shareFooterNotice({ label, rev, status: doc.status ?? null, verifyUrl }),
      verifyUrl,
    });
    outBytes = await pdfDoc.save();
    stamped = true;
  } catch (e) {
    // Not a stampable PDF (encrypted / corrupt / scanned oddity). Deliver it
    // anyway — but through this route, never a raw bucket URL, and the audit
    // row below records that it went out unmarked.
    console.warn("[share/file] stamping failed — delivering unstamped", (e as Error).message);
  }

  // The distribution record, BEFORE the bytes leave. Attributed to the share
  // (DEC-44 §1): user_id NULL, share_id set, the channel in `source`. A
  // checked write — a refusal (column drift, a missing migration, RLS) is
  // logged loudly and the copy does NOT go out unrecorded.
  const { error: auditError } = await sb.from("download_audits").insert({
    org_id: share.org_id,
    document_id: doc.id,
    version_id: version.id,
    user_id: null,
    user_email: null,
    created_at: new Date().toISOString(),
    expires_at: share.expires_at ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
    watermark_policy_id: null,
    source: stamped ? "share_link" : "share_link_unstamped",
    share_id: share.id,
  });
  if (auditError) {
    console.error("[share/file] download_audits insert failed — share download refused, nothing left the building", {
      share: share.id, document: doc.id, version: version.id, message: auditError.message,
    });
    return NextResponse.json({ error: "unrecorded" }, { status: 503 });
  }

  const meta = requestMeta(req);
  await recordShareAccess(sb, { share, documentId: doc.id, versionId: version.id, kind: "download", ...meta });

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
