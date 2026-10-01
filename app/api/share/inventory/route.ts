// GET /api/share/inventory?orgId=<id> — DIST-15: every external share link in
// the org, for Admin → Share links.
//
// Authority: the controller tier, by the caller's full role collection —
// every role isControllerRole admits (DEC-35: no role list here; the same tier
// is_org_controller means in SQL). Anyone else gets 403 with the reason. A
// controller passes node_visible on every document (20261066's read
// decision), so the service-role read below hands back nothing the caller's
// own session could not read.
//
// What it returns: each share row joined to its document (number, title,
// status, library) and library name, whether the creator is still an ACTIVE
// member, expiry, access count and last access — and NEVER the token (DEC-45:
// a bearer column does not leave the database for a listing; revoking needs
// only the id). Newest first, at most SHARE_INVENTORY_LIMIT rows, `truncated`
// when there were more. Fails closed: a read that errors is a 500, never an
// empty inventory.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { isControllerRole } from "@/lib/permissions";
import { ALL_ROLES } from "@/types/schema";
import { SHARE_INVENTORY_DENIED, SHARE_INVENTORY_LIMIT, type ShareInventoryRow } from "@/lib/shareInventory";

export const runtime = "nodejs";

/** The controller tier — every role isControllerRole admits (DEC-35: the
 *  predicate, not a literal set). */
const CONTROLLER_ROLES = ALL_ROLES.filter((r) => isControllerRole(r));

const SHARE_COLUMNS = "id, document_id, created_by, created_by_name, created_at, expires_at, revoked_at, revoked_by, access_count, access_last_at, note";

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orgId)) return bad("orgId is required", 400);

  const actor = await authorizeOrgRole(req, orgId, CONTROLLER_ROLES);
  if ("error" in actor) return bad(actor.status === 403 ? SHARE_INVENTORY_DENIED : actor.error, actor.status);
  const db = actor.admin;

  const { data: shareRows, error: shareErr } = await db
    .from("document_shares")
    .select(SHARE_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(SHARE_INVENTORY_LIMIT + 1);
  if (shareErr) return bad("Failed to load the share links", 500);
  const all = (shareRows ?? []) as Array<Record<string, unknown>>;
  const truncated = all.length > SHARE_INVENTORY_LIMIT;
  const shares = all.slice(0, SHARE_INVENTORY_LIMIT);

  const docIds = [...new Set(shares.map((s) => String(s.document_id)))];
  const creatorIds = [...new Set(shares.map((s) => String(s.created_by)))];
  const docs = new Map<string, Record<string, unknown>>();
  const libs = new Map<string, string>();
  const active = new Set<string>();
  if (docIds.length > 0) {
    const { data: docRows, error: docErr } = await db
      .from("documents").select("id, document_number, title, status, library_id").eq("org_id", orgId).in("id", docIds);
    if (docErr) return bad("Failed to load the shared documents", 500);
    for (const d of (docRows ?? []) as Array<Record<string, unknown>>) docs.set(String(d.id), d);
    const libIds = [...new Set([...docs.values()].map((d) => d.library_id).filter(Boolean).map(String))];
    if (libIds.length > 0) {
      const { data: libRows, error: libErr } = await db.from("libraries").select("id, name").eq("org_id", orgId).in("id", libIds);
      if (libErr) return bad("Failed to load the libraries", 500);
      for (const l of (libRows ?? []) as Array<Record<string, unknown>>) libs.set(String(l.id), String(l.name ?? ""));
    }
    const { data: members, error: memErr } = await db
      .from("org_members").select("uid, status").eq("org_id", orgId).in("uid", creatorIds);
    if (memErr) return bad("Failed to check the creators' membership", 500);
    for (const m of (members ?? []) as Array<Record<string, unknown>>) if (m.status === "active") active.add(String(m.uid));
  }

  const rows: ShareInventoryRow[] = shares.map((s) => {
    const d = docs.get(String(s.document_id));
    const libraryId = d?.library_id ? String(d.library_id) : null;
    return {
      id: String(s.id),
      documentId: String(s.document_id),
      documentNumber: (d?.document_number as string | null) ?? null,
      documentTitle: (d?.title as string | null) ?? null,
      documentStatus: (d?.status as string | null) ?? null,
      libraryId,
      libraryName: libraryId ? libs.get(libraryId) ?? null : null,
      createdBy: String(s.created_by),
      createdByName: (s.created_by_name as string | null) ?? null,
      creatorActive: active.has(String(s.created_by)),
      createdAt: (s.created_at as string | null) ?? null,
      expiresAt: (s.expires_at as string | null) ?? null,
      revokedAt: (s.revoked_at as string | null) ?? null,
      revokedBy: (s.revoked_by as string | null) ?? null,
      accessCount: Number(s.access_count ?? 0),
      accessLastAt: (s.access_last_at as string | null) ?? null,
      note: (s.note as string | null) ?? null,
    };
  });
  return NextResponse.json({ rows, truncated }, { headers: { "Cache-Control": "no-store" } });
}
