// /api/transmittal/register — DIST-17 (document-control P27): the transmittal
// register, read by the server and filtered for the signed-in viewer.
//
//   GET ?orgId=<org>[&id=<transmittal>]  → { transmittals: Transmittal[] }
//
// Until P27 the register (/transmittals) read every transmittal of the org
// with the member's browser client (transmittals_select, 20260910: any active
// member reads the whole row), and every row's cover sheet printed each
// item's number, title and revision — and, for a live link, the portal URL
// and QR that download the as-sent files — whatever the documents' ACL.
// Now (the integrator's rulings under DEC-90):
//   1. a transmittal's items are shown only to a member the document read
//      predicate lets read each item — lib/permissions canReadNode over the
//      full library → folder → document chain, asked through
//      lib/knowledgeAccess readableControlledDocIds (the I-12 predicate; no
//      second walk) — to its sender, and to controllers; anyone else sees
//      the transmittal and its non-identifying fields, each unreadable item
//      as "Restricted document";
//   2. the portal token is handed only to someone who may read every item;
//   — lib/transmittals redactTransmittalForViewer, on every row.
// The population is the one transmittals_select admits: active members of
// the org (loadPrincipal answers null for anyone else → 403). The same
// 1,000 newest rows, newest first, as the browser read.
//
// Fail closed: a membership or teams read that fails answers 503 "try
// again" (KACL-12 — never "not a member"); a document landscape that cannot
// be read leaves the decision undecided — the sender and controllers keep
// their full rows, everyone else's items are withheld and no token is handed
// out but to a controller, each row saying so (`viewer.accessUnchecked`).
// The REST read of the table itself is not narrowed here (DIST-18).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadPrincipal, readableControlledDocIds, PrincipalUnreadableError, DcLandscapeUnreadableError, PRINCIPAL_UNREADABLE,
} from "@/lib/knowledgeAccess";
import { redactTransmittalForViewer, rowToTransmittal } from "@/lib/transmittals";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION_HINT =
  "Transmittals aren't set up yet — run supabase/migrations/20260717_transmittals.sql, then reload.";

function bad(msg: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: msg, ...extra }, { status });
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!UUID_RE.test(orgId)) return bad("orgId is required", 400);
  if (id && !UUID_RE.test(id)) return bad("id must be a transmittal id", 400);

  let principal: Awaited<ReturnType<typeof loadPrincipal>>;
  try {
    principal = await loadPrincipal(orgId, user.id);
  } catch (e) {
    if (e instanceof PrincipalUnreadableError) return bad(PRINCIPAL_UNREADABLE, 503, { unreadable: true });
    throw e;
  }
  if (!principal) return bad("Not a member of this workspace.", 403);

  let q = supabaseAdmin.from("transmittals").select("*").eq("org_id", orgId);
  if (id) q = q.eq("id", id);
  const { data, error } = await q.order("seq", { ascending: false }).limit(1000);
  if (error) {
    const missing = error.code === "42P01" || /relation .*transmittals.* does not exist/i.test(error.message ?? "");
    if (missing) return bad(MIGRATION_HINT, 404, { missingTable: true });
    console.error("[transmittal/register] the register read failed", error.message);
    return bad("Couldn't load the transmittal register — try again.", 500);
  }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(rowToTransmittal);

  // One read decision for every item the rows name (a controller is answered
  // before any read — DEC-43).
  let readable: Set<string> | null = new Set();
  if (!principal.isController) {
    const docIds = [...new Set(rows.flatMap((t) => t.items.map((i) => i.documentId)).filter((d): d is string => !!d))];
    try {
      readable = await readableControlledDocIds(principal, docIds);
    } catch (e) {
      if (!(e instanceof DcLandscapeUnreadableError)) throw e;
      console.warn("[transmittal/register] the document read decision could not be made — items and portal links withheld (fail closed)", e.message);
      readable = null;
    }
  }

  const who = { uid: user.id, isController: principal.isController };
  return NextResponse.json({ transmittals: rows.map((t) => redactTransmittalForViewer(t, who, readable)) });
}
