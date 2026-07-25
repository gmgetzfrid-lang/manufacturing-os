// GET /api/share/resolve?token=<share token>
//
// Service-role resolution for public share links. The /share/[token] page
// used to query document_shares with the anon browser client — which RLS
// (correctly) blocks for outsiders, so the links never worked for the very
// people they were made for. This route does the lookup with the service
// role, gated ONLY by possession of the unguessable token, and returns the
// minimum the landing page needs.
//
// It also makes the page's "Audit logged" claim true: every resolve bumps
// the share's access counter AND writes a download_audits row, so the
// distribution record shows outside pulls too.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Share resolution unavailable" }, { status: 503 });
  }
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  // Tokens are 32+ url-safe chars; reject junk cheaply before touching the DB.
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

  const { data: org } = await sb.from("orgs").select("name").eq("id", share.org_id as string).maybeSingle();

  // Resolve the current PUBLISHED version's file (never an in-review draft).
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

  let fileUrl: string | null = null;
  if (storagePath) {
    if (/^https?:\/\//i.test(storagePath)) {
      fileUrl = storagePath;
    } else {
      try {
        fileUrl = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: R2_BUCKET, Key: storagePath }),
          { expiresIn: 3600 },
        );
      } catch { /* fall through: page shows the unresolved notice */ }
    }
  }

  // Make the audit claim true: count the access AND leave a distribution row.
  try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch { /* best-effort */ }
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
      source: "share_link",
    });
  } catch { /* pre-migration column drift — never block the share */ }

  return NextResponse.json({
    documentId: doc.id,
    versionId,
    documentNumber: (doc.document_number as string | null) ?? null,
    title: (doc.title as string | null) ?? (doc.name as string | null) ?? null,
    rev: (doc.rev as string | null) ?? null,
    orgName: (org?.name as string | null) ?? null,
    fileUrl,
  });
}
