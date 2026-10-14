// POST /api/push/unsubscribe — turn Web Push off for THIS device
// (notifications Round G, N10 PUSH — GAP-205).
//
// Body { endpoint }: removes the signed-in member's own push_subscriptions
// row for that endpoint (20260804). Only their own — the filter names the
// caller, as the table's own-row delete policy would. Called by
// components/settings/PushOptIn.tsx after the browser's own
// PushSubscription.unsubscribe(). Removing nothing is not an error (the row
// may already be gone: a 404 / 410 pruned it, or another person turned
// notifications on in this browser since). Before 20260804 is applied there
// is nothing to remove.
//
// This is the per-device switch. The person-wide pause is
// notification_preferences.push_enabled, which stops delivery to every
// device and leaves them registered (GAP-205 acceptance 2).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return answer({ error: "Not authenticated" }, 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return answer({ error: "Not authenticated" }, 401);

  let body: { endpoint?: unknown };
  try { body = await req.json(); } catch { return answer({ error: "Invalid JSON body" }, 400); }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2048) return answer({ error: "endpoint is required" }, 400);

  const removed = await checkedWrite(supabaseAdmin
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", user.id)
    .select("id"));
  if (removed.ok) return answer({ ok: true, removed: removed.ids.length });
  if (removed.code === "refused") return answer({ ok: true, removed: 0 });
  if (removed.pgCode && isMissingSchemaError({ message: removed.error, code: removed.pgCode })) return answer({ ok: true, removed: 0 });
  return answer({ error: removed.error }, 500);
}
