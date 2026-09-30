// GET /api/share/resolve?token=<share token>
//
// Service-role resolution for public share links. The /share/[token] page
// used to query document_shares with the anon browser client — which RLS
// (correctly) blocks for outsiders, so the links never worked for the very
// people they were made for. This route does the lookup with the service
// role, gated ONLY by possession of the unguessable token, and returns the
// minimum the landing page needs.
//
// The decision — token, org-joined document, the creator's current
// authority, the document's control status, its holds, and which version is
// servable — is lib/shareServe.ts, shared byte-for-byte with /api/share/file
// so the page and the bytes can never disagree (SHR-6). A share always
// serves the CURRENT issued revision; a Draft / Superseded / Void / Archived
// or held document is refused with the reason (DRLS-5 / EGR-5 / REV-10).
//
// Every resolve records one access row (IP + user agent, no recipient
// identification — SHR-10) and bumps the share's counter; a refused attempt
// on a known share records a "refused" row with the reason (bounded, one per
// share per minute). The download_audits row is written by /api/share/file
// (an actual download).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { recordShareAccess, requestMeta, resolveShareForServing, servedLabels } from "@/lib/shareServe";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Share resolution unavailable" }, { status: 503 });
  }
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const meta = requestMeta(req);
  const resolved = await resolveShareForServing(sb, token, meta);
  if (!resolved.ok) return NextResponse.json(resolved.body, { status: resolved.status });
  const { share, doc, version } = resolved;

  const { data: org } = await sb.from("orgs").select("name").eq("id", share.org_id).maybeSingle();

  // The page never receives a raw bucket URL. Downloads go through
  // /api/share/file, which stamps SERVER-SIDE (watermark + rev footer +
  // verify QR) before any byte leaves and writes the download_audits row.
  const fileUrl: string | null = version ? `/api/share/file?token=${encodeURIComponent(token)}` : null;

  await recordShareAccess(sb, { share, documentId: doc.id, versionId: version?.id ?? null, kind: "resolve", ...meta });

  // The counter is a convenience the modal shows; a missing function or a
  // refused call must be VISIBLE, not an unreachable catch (SHR-12).
  const { error: bumpError } = await sb.rpc("bump_share_access", { p_share: share.id, p_ip: meta.ip });
  if (bumpError) console.error("[share/resolve] bump_share_access failed", { share: share.id, message: bumpError.message });

  const { rev } = servedLabels(doc, version);
  return NextResponse.json({
    documentId: doc.id,
    versionId: version?.id ?? null,
    documentNumber: doc.document_number ?? null,
    title: doc.title ?? doc.name ?? null,
    rev,
    status: doc.status ?? null,
    orgName: (org?.name as string | null) ?? null,
    expiresAt: share.expires_at ?? null,
    fileUrl,
  });
}
