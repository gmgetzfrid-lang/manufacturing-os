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
// stamped with the same applyStampToPdfDoc as internal downloads — the same
// marks, but placed BLIND: a server has no DOM for the ink analysis the
// browser paths run, so the QR and footer take the title-block-aware
// fallback (top-left, clear of the right-hand title block — SHR-8).
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
//
// Deploy order: the record's share-attributed shape needs 20261068's
// columns (share_id, source, nullable user_id); apply 20261068 → 20261080 →
// 20261081 before this route deploys. If it deploys first anyway, a refusal
// that IS the missing migration is logged as exactly that and the record is
// retried ONCE in the pre-20261068 shape (the real columns only, attributed
// to the sharer as the table required then) — the copy is recorded and
// served, never refused wholesale. Only when that retry also fails, or the
// first refusal is anything else, is the download refused 503 "unrecorded".
//
// The verify QR's origin (SHR-11 off Vercel, DEC-64 §1): the configured
// public origin (NEXT_PUBLIC_SITE_URL, else Vercel's production domain);
// else the origin of the request URL AS THE SERVER SEES IT, unless its host
// is one an outside party cannot open (a *.vercel.app deployment host or
// loopback, refused exactly as recipientOrigin() refuses them); else the
// download is refused loudly (503 "unverifiable", logged, on the access
// trail) rather than shipping a copy nobody can verify.
//
// What that request URL is depends on the runtime. On Vercel it carries the
// host the recipient reached (a custom domain is used; a *.vercel.app host
// is refused). Under `next start` — the Docker image's CMD — Next builds it
// from the server's BIND address, not the Host header (http://localhost:3000
// unless -H is given; the Host header is read only with
// experimental.trustHostHeader), so a self-hosted deployment with
// NEXT_PUBLIC_SITE_URL unset REFUSES EVERY share download until the variable
// is set (a build argument of the Docker image; 99-fix-sequencing.md). That
// refusal is the intended loud failure, not a fallback. The Host /
// X-Forwarded-Host headers are never trusted here.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { PDFDocument } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { configuredPublicOrigin, isUnreachableRecipientHost } from "@/lib/publicOrigin";
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

  const meta = requestMeta(req);
  const resolved = await resolveShareForServing(sb, token, meta);
  if (!resolved.ok) return NextResponse.json(resolved.body, { status: resolved.status });
  const { share, doc, version } = resolved;
  if (!version) {
    await recordShareAccess(sb, { share, documentId: doc.id, versionId: null, kind: "refused", reason: "nofile", ...meta });
    return NextResponse.json({ error: "nofile" }, { status: 404 });
  }

  // SHR-11: where the copy's verify QR points — decided BEFORE any byte is
  // read, so an unverifiable copy is never produced.
  const origin = verifyOrigin(req);
  if (!origin) {
    console.error("[share/file] no public origin for the verify QR — share download refused. Set NEXT_PUBLIC_SITE_URL to the deployment's public address (a build argument for the Docker image); the request host is a Vercel deployment host or loopback (under `next start` it is the server's bind address), which an outside recipient cannot open.", {
      share: share.id, document: doc.id, host: req.nextUrl.hostname,
    });
    await recordShareAccess(sb, { share, documentId: doc.id, versionId: version.id, kind: "refused", reason: "unverifiable", ...meta });
    return NextResponse.json({
      error: "unverifiable",
      message: "This shared copy can't be issued right now: the site has no public address to put on its verification QR. Ask the person who shared it to contact their Document Control.",
    }, { status: 503 });
  }

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
  const verifyUrl = `${origin}/verify/${doc.id}?v=${version.id}`;

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
  const base = {
    org_id: share.org_id,
    document_id: doc.id,
    version_id: version.id,
    user_email: null,
    created_at: new Date().toISOString(),
    expires_at: share.expires_at ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
    watermark_policy_id: null,
  };
  let { error: auditError } = await sb.from("download_audits").insert({
    ...base,
    user_id: null,
    source: stamped ? "share_link" : "share_link_unstamped",
    share_id: share.id,
  });
  if (auditError && missingRecordColumn(auditError)) {
    // 20261068 is not applied yet: the table has no share_id / source and
    // user_id is NOT NULL. Record the copy in the shape the table has — the
    // pre-DEC-44 attribution to the sharer — rather than lock every outside
    // recipient out until the paste lands.
    console.error("[share/file] DEPLOY ORDER: download_audits lacks the 20261068 columns (share_id / source) — apply 20261068 → 20261080 → 20261081; recording this share download in the pre-20261068 shape (attributed to the sharer)", {
      share: share.id, document: doc.id, version: version.id, stamped, message: auditError.message,
    });
    ({ error: auditError } = await sb.from("download_audits").insert({ ...base, user_id: share.created_by }));
  }
  if (auditError) {
    console.error("[share/file] download_audits insert failed — share download refused, nothing left the building", {
      share: share.id, document: doc.id, version: version.id, message: auditError.message,
    });
    await recordShareAccess(sb, { share, documentId: doc.id, versionId: version.id, kind: "refused", reason: "unrecorded", ...meta });
    return NextResponse.json({ error: "unrecorded" }, { status: 503 });
  }

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

/** SHR-11 (off Vercel) / DEC-64 §1: the configured public origin, else the
 *  request URL's origin when an outside recipient can open its host (never a
 *  *.vercel.app deployment host or loopback — recipientOrigin()'s rule,
 *  isUnreachableRecipientHost), else "" (the caller refuses loudly). Under
 *  `next start` req.nextUrl is built from the bind address (localhost:3000
 *  by default), so off Vercel this answers "" until NEXT_PUBLIC_SITE_URL is
 *  set; no request header is consulted. */
function verifyOrigin(req: NextRequest): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  let url: URL;
  try { url = new URL(req.nextUrl.origin); } catch { return ""; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return isUnreachableRecipientHost(url.hostname) ? "" : url.origin;
}

/** A refused record write that is the unapplied 20261068, not a transient:
 *  PostgREST's unknown-column (PGRST204) / Postgres' undefined_column (42703),
 *  a message naming one of the columns 20261068 adds, or the pre-20261068
 *  NOT NULL on user_id refusing a share's (user-less) row. Only this earns
 *  the one pre-20261068-shape retry; anything else refuses the download. */
function missingRecordColumn(e: { code?: string; message?: string }): boolean {
  const msg = e.message ?? "";
  return e.code === "PGRST204" || e.code === "42703" || /\b(share_id|source)\b/.test(msg)
    || (e.code === "23502" && /\buser_id\b/.test(msg));
}
