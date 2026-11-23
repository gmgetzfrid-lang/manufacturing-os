// GET /api/share/list?orgId=<org>&docIds=<a,b,c> - the links already sent
// outside the company that cover any of these documents.
//
// Only documents the caller can open are looked up, so the list never says
// anything about a document they can't see. The link itself (its token) is
// returned only to the person who made it, so they can copy it again. The
// code's hash never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { publicOrigin } from "@/lib/publicOrigin";
import {
  CODE_LOCK_AT, SHARE_COLS, SHARE_SQL_MESSAGE, UUID_RE,
  isMissingShareColumn, shareItems, withLegacyDefaults, type ShareRow,
} from "@/lib/shareLinks";
import type { SentLink } from "@/lib/documentShares";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  if (!UUID_RE.test(orgId)) return bad("Which workspace?");
  const asked = [...new Set((req.nextUrl.searchParams.get("docIds") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)))].slice(0, 200);
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return bad("Sign in again.", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (authErr || !user) return bad("Sign in again.", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("You're not a member of this workspace.", 403);
  if (asked.length === 0) return NextResponse.json({ links: [] });

  let readable: Set<string>;
  try { readable = await readableControlledDocIds(principal, asked); }
  catch (e) { return bad(`Who can open these documents couldn't be checked: ${(e as Error).message}`, 500); }
  const ids = asked.filter((id) => readable.has(id));
  if (ids.length === 0) return NextResponse.json({ links: [] });

  // Links made for one of these first (every link has document_id), and
  // links that carry one of these further down their list.
  const [byFirst, byAny] = await Promise.all([
    supabaseAdmin.from("document_shares").select(SHARE_COLS).eq("org_id", orgId).in("document_id", ids)
      .order("created_at", { ascending: false }).limit(100),
    supabaseAdmin.from("document_shares").select(SHARE_COLS).eq("org_id", orgId).overlaps("document_ids", ids)
      .order("created_at", { ascending: false }).limit(100),
  ]);
  const err = byFirst.error ?? byAny.error;
  if (err) {
    if (isMissingShareColumn(err)) return bad(SHARE_SQL_MESSAGE, 503);
    return bad(`The links couldn't be read: ${err.message}`, 500);
  }
  const rows = new Map<string, ShareRow>();
  for (const r of [...(byFirst.data ?? []), ...(byAny.data ?? [])] as Array<Record<string, unknown>>) {
    const row = withLegacyDefaults(r);
    rows.set(row.id, row);
  }

  const origin = publicOrigin() || req.nextUrl.origin;
  const links: SentLink[] = [...rows.values()]
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .map((r) => {
      const its = shareItems(r);
      const mine = r.created_by === user.id;
      return {
        id: r.id,
        url: mine ? `${origin}/share/${r.token}` : null,
        mine,
        recipient: r.recipient ?? r.note ?? null,
        createdAt: r.created_at,
        createdByName: r.created_by_name,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        accessCount: Number(r.access_count ?? 0) || 0,
        accessLastAt: r.access_last_at,
        withCode: !!r.code_hash,
        allowDownload: r.allow_download,
        locked: !!r.code_hash && r.code_failures >= CODE_LOCK_AT,
        documentIds: its.map((i) => i.documentId),
        markedUpIds: its.filter((i) => i.markupPath).map((i) => i.documentId),
      };
    });
  return NextResponse.json({ links });
}
