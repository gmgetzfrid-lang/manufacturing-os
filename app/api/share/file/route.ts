// GET /api/share/file?token=<token>&doc=<documentId>[&view=1]
//   (header x-share-code: 123456 when the link asks for a code)
//
// One document from a link, stamped SERVER-SIDE (uncontrolled watermark with
// who it was sent to, rev footer, verify QR) before a single byte leaves.
//
//   view=1   shown in the page's own viewer: always allowed.
//   no view  saved as a file: only when the sender let them download.
//
// A marked-up copy (the sender's markups, uploaded when the link was made)
// is served instead of the issued file for that document, and is stamped
// the same way. A file that can't carry the stamp is not sent at all: these
// copies must always say they are uncontrolled.
//
// Why server-side: the bucket has no CORS, so a browser-side stamp fetch
// failed and the old fallback opened the raw file. Here bytes go bucket to
// server, no CORS in play, through the same applyStampToPdfDoc as internal
// downloads. Every file served writes a download_audits row (a view or a
// download), attributed to the sender since the outsider has no account.

import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { PDFDocument } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";
import {
  SHARE_TOKEN_RE, UUID_RE, docLabel, fileKind, gateShare, isMissingShareColumn,
  loadShareByToken, resolveIssuedFile, shareItems, type ShareRow,
} from "@/lib/shareLinks";

export const runtime = "nodejs";
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const no = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/** Bytes from the app's own bucket only. A web address is never fetched
 *  (a stored file_url must not make the server call arbitrary hosts), and a
 *  key under another workspace's folder is refused. */
async function readObject(path: string, orgId: string): Promise<Uint8Array> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error("not a storage key");
  const owner = path.match(/^orgs\/([0-9a-fA-F-]{36})\//)?.[1];
  if (owner && owner.toLowerCase() !== orgId.toLowerCase()) throw new Error("key outside this workspace");
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }));
  const bytes = await obj.Body?.transformToByteArray();
  if (!bytes) throw new Error("empty object body");
  return bytes;
}

/** A picture becomes a one-page PDF so it can carry the same stamp. */
async function pdfFrom(source: Uint8Array, kind: "pdf" | "png" | "jpg"): Promise<PDFDocument> {
  if (kind === "pdf") return PDFDocument.load(source);
  const pdf = await PDFDocument.create();
  const img = kind === "png" ? await pdf.embedPng(source) : await pdf.embedJpg(source);
  const scale = Math.min(1, 1224 / Math.max(img.width, img.height)); // at most 17 in on the long side
  const w = img.width * scale, h = img.height * scale;
  pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return pdf;
}

async function recordServed(sb: SupabaseClient, share: ShareRow, documentId: string, versionId: string | null, mode: "view" | "download", markedUp: boolean) {
  const base = {
    org_id: share.org_id,
    document_id: documentId,
    version_id: versionId,
    user_id: share.created_by, // the outsider has no account: the sender answers for the copy
    user_email: null,
    created_at: new Date().toISOString(),
    expires_at: share.expires_at ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
    watermark_policy_id: null,
  };
  const source = `share_${mode}${markedUp ? "_markup" : ""}`;
  const { error } = await sb.from("download_audits").insert({ ...base, source });
  if (!error) return;
  // Before the migration download_audits has no source column: keep the
  // row, and say view or download in the audit log instead.
  if (isMissingShareColumn(error)) {
    await sb.from("download_audits").insert(base).then(() => undefined, () => undefined);
  }
  await sb.from("audit_logs").insert({
    action: mode === "view" ? "SHARE_LINK_VIEWED" : "SHARE_LINK_DOWNLOADED",
    resource_type: "document_share", resource_id: share.id,
    org_id: share.org_id, user_id: share.created_by, user_email: null,
    details: { documentId, versionId, markedUp, recipient: share.recipient ?? share.note ?? null, source },
  }).then(() => undefined, () => undefined);
}

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) return no("unavailable", 503);
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!SHARE_TOKEN_RE.test(token)) return no("invalid", 400);
  const docParam = (req.nextUrl.searchParams.get("doc") ?? "").trim();
  if (docParam && !UUID_RE.test(docParam)) return no("invalid", 400);
  const view = req.nextUrl.searchParams.get("view") === "1";

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { row: share, error } = await loadShareByToken(sb, token);
  if (error) return no("unavailable", 503);
  if (!share) return no("notfound", 404);
  const gate = await gateShare(sb, share, req.headers.get("x-share-code"));
  if (!gate.ok) return no(gate.error, gate.status);

  const items = shareItems(share);
  const item = docParam ? items.find((i) => i.documentId === docParam) : items.length === 1 ? items[0] : undefined;
  if (!item) return no("notfound", 404);
  if (!view && !share.allow_download) return no("nodownload", 403);

  const { data: docRow } = await sb.from("documents")
    .select("id, document_number, title, name, rev, current_version_id")
    .eq("id", item.documentId).eq("org_id", share.org_id).maybeSingle();
  const doc = docRow as { id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; current_version_id: string | null } | null;
  if (!doc) return no("notfound", 404);

  // The marked-up copy when the sender sent one, else the issued file.
  const issued = await resolveIssuedFile(sb, { ...doc, org_id: share.org_id });
  const path = item.markupPath ?? issued?.path ?? null;
  if (!path) return no("nofile", 404);
  const kind = item.markupPath ? "pdf" : fileKind(path, issued?.fileType);
  if (kind === "other") return no("unstampable", 422);
  const versionId = issued?.versionId ?? doc.current_version_id ?? null;

  let source: Uint8Array;
  try { source = await readObject(path, share.org_id); }
  catch (e) {
    console.warn("[share/file] file fetch failed", (e as Error).message);
    return no("unavailable", 502);
  }

  const label = docLabel(doc);
  const rev = doc.rev ?? null;
  const markedUp = !!item.markupPath;
  let outBytes: Uint8Array;
  try {
    const pdfDoc = await pdfFrom(source, kind);
    await applyStampToPdfDoc(pdfDoc, {
      userLabel: `For ${share.recipient ?? share.note ?? "shared link"}`,
      timestamp: new Date(),
      watermarkText: "UNCONTROLLED - SHARED COPY",
      footerNotice: `${label} Rev ${rev ?? "?"}${markedUp ? ", marked-up copy," : ""} at time of sending. Scan the QR to check it is still current.`,
      verifyUrl: versionId && publicOrigin()
        ? `${publicOrigin()}/verify/${doc.id}?v=${versionId}`
        : undefined,
    });
    outBytes = await pdfDoc.save();
  } catch (e) {
    // Not stampable (encrypted, damaged). It does not go out unmarked.
    console.warn("[share/file] stamping failed - not sent", (e as Error).message);
    return no("unstampable", 422);
  }

  try { await recordServed(sb, share, doc.id, versionId, view ? "view" : "download", markedUp); }
  catch { /* the record never blocks the copy */ }

  const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
  const filename = `${safe(label)}_Rev${safe(rev ?? "0")}${markedUp ? "_markup" : ""}.pdf`;
  return new NextResponse(Buffer.from(outBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${view ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
