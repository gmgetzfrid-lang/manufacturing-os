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

  // The page never receives a raw bucket URL anymore. Downloads go through
  // /api/share/file, which stamps SERVER-SIDE (watermark + rev footer +
  // verify QR) before any byte leaves — the old client-side stamp fetch was
  // CORS-blocked by the bucket, so its fallback leaked the raw file. That
  // route also writes the download_audits row (an actual download); this one
  // only bumps the access counter (link opened).
  const fileUrl: string | null = storagePath
    ? `/api/share/file?token=${encodeURIComponent(token)}`
    : null;

  try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch { /* best-effort */ }

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
