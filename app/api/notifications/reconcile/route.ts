// /api/notifications/reconcile — the attention feed's reconcile pass, on the
// server (notifications Round G, N4 — NEDGE-18, TRAIL-9, DEC-81 §2).
//
// The feed (components/providers/AttentionProvider.tsx, through
// hooks/useTicketNotifications.ts) sends the ids of the rows in its window
// whose condition may be gone — a workflow alert whose ticket moved on, a hold
// that was released, a branch that was resolved, a stale-checkout escalation
// whose session ended, an acknowledgment / sign-off / recertification that was
// discharged. This route re-checks each one against the database and marks the
// gone ones metadata.superseded_at (lib/notificationReconcileServer.ts).
//
// Who may ask: a signed-in, ACTIVE member of the org, about their OWN rows —
// the server reads each id back as the caller's own unread, unsuperseded row
// in that org and ignores any other. It never writes read_at, never another
// column, never another person's row, and never a row whose condition still
// holds. It answers only which of the caller's ids it retired.
//
// Why a route: since 20261161 a recipient may change only read_at on their own
// row from the browser (trg_notifications_read_at_only), so the browser-side
// mark the feed used to write was refused (NEDGE-18). The service role passes
// that trigger, so this works before and after the paste.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { retireStaleAlerts } from "@/lib/notificationReconcileServer";
import { RECONCILE_MAX_IDS } from "@/lib/notificationReconcile";

export const runtime = "nodejs";

const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: unknown; ids?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const ids = Array.isArray(body.ids)
    ? [...new Set((body.ids as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : null;
  if (!orgId || ids === null) return bad("orgId and ids are required");
  if (ids.length > RECONCILE_MAX_IDS) return bad(`Send up to ${RECONCILE_MAX_IDS} notifications per call (got ${ids.length}).`);

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return bad("Couldn't confirm your membership — try again.", 503);
  if (!member) return bad("Not an active member of this organization.", 403);

  const answer = await retireStaleAlerts(supabaseAdmin, { orgId, uid: user.id, ids });
  if (answer.error) return bad(answer.error, 503);
  return NextResponse.json(
    { retired: answer.retired, kept: answer.kept, failed: answer.failed },
    { headers: { "Cache-Control": "no-store" } },
  );
}
