// GET /api/share/resolve?token=<share token>   (header x-share-code: 123456)
//
// What the public /share/<token> page shows: who sent the link, for whom,
// until when, and the documents on it. No sign-in: the unguessable token is
// the key, and when the link asks for a code, the code too. A wrong code
// counts toward the lockout (10 and the link is locked for good); the
// answer never says more than "that code isn't right".
//
// Each successful open bumps the link's open counter. The files themselves
// come from /api/share/file, which stamps them and records each one served.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  SHARE_TOKEN_RE, fileKind, gateShare, loadShareByToken, resolveIssuedFile, shareItems,
} from "@/lib/shareLinks";
import type { ResolvedShare, ResolvedShareItem } from "@/lib/documentShares";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const no = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) return no("unavailable", 503);
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  // Tokens are 32 url-safe chars; reject junk cheaply before touching the DB.
  if (!SHARE_TOKEN_RE.test(token)) return no("invalid", 400);

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { row: share, error } = await loadShareByToken(sb, token);
  if (error) return no("unavailable", 503);
  if (!share) return no("notfound", 404);
  const gate = await gateShare(sb, share, req.headers.get("x-share-code"));
  if (!gate.ok) return no(gate.error, gate.status);

  const items = shareItems(share);
  const ids = items.map((i) => i.documentId);
  const { data: docRows } = ids.length
    ? await sb.from("documents").select("id, org_id, document_number, title, name, rev, current_version_id")
      .eq("org_id", share.org_id).in("id", ids)
    : { data: [] };
  type Doc = { id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; current_version_id: string | null };
  const byId = new Map(((docRows ?? []) as Doc[]).map((d) => [d.id, d]));

  const out: ResolvedShareItem[] = [];
  for (const it of items) {
    const d = byId.get(it.documentId);
    if (!d) continue; // deleted since the link was made
    let viewable = !!it.markupPath;
    if (!viewable) {
      const f = await resolveIssuedFile(sb, d);
      viewable = !!f && fileKind(f.path, f.fileType) !== "other";
    }
    out.push({
      documentId: d.id,
      documentNumber: d.document_number ?? null,
      title: d.title ?? d.name ?? null,
      rev: d.rev ?? null,
      markedUp: !!it.markupPath,
      viewable,
    });
  }
  if (out.length === 0) return no("notfound", 404);

  const { data: org } = await sb.from("orgs").select("name").eq("id", share.org_id).maybeSingle();
  try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch { /* best-effort */ }

  const body: ResolvedShare = {
    orgName: (org as { name?: string | null } | null)?.name ?? null,
    senderName: share.created_by_name ?? null,
    recipient: share.recipient ?? share.note ?? null,
    expiresAt: share.expires_at,
    allowDownload: share.allow_download,
    items: out,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
