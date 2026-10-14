// /api/push/subscribe — register THIS device for Web Push
// (notifications Round G, N10 PUSH — GAP-205, OS-2 done-when 1, TAX-12
// done-when 1, RT-7 done-when 2).
//
// GET  → { configured, publicKey }: whether the server has VAPID keys, and
//        the public key the browser subscribes with
//        (pushManager.subscribe({ userVisibleOnly: true,
//        applicationServerKey })). The public half of a VAPID pair is public
//        by design; the private half never leaves lib/push/sendPush.ts.
// POST { orgId, subscription: { endpoint, keys: { p256dh, auth } } } →
//        stores the device the signed-in member just turned on, as their own
//        push_subscriptions row (20260804). Called only by
//        components/settings/PushOptIn.tsx, after the person's click and the
//        browser's permission — a row here is the explicit per-device opt-in
//        the sender requires (OS-10 done-when 1).
//
// One browser profile has one push endpoint. When a second person turns
// notifications on in the same browser, the endpoint is theirs from then on:
// the previous person's row for it is replaced (the takeover needs the
// service role — the table's own-row RLS lets a member delete only their own
// row). The caller proves the device by presenting its live subscription.
//
// Before 20260804 is applied the POST answers 503 and says so; the page shows
// it and nothing else changes.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";
import { pushConfig } from "@/lib/push/sendPush";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const PUSH_TABLE_MISSING =
  "Device notifications need a database update that has not been applied yet (20260804_push_subscriptions.sql). Nothing was changed.";
const PUSH_NOT_CONFIGURED = "Device notifications are not set up on this server yet.";

/** A push endpoint: an https URL of sane length. */
function validEndpoint(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}
/** A subscription key: base64url, bounded. */
function validKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && /^[A-Za-z0-9_-]+=*$/.test(v);
}

export async function GET() {
  const config = pushConfig();
  return answer({ configured: !!config, publicKey: config?.publicKey ?? null });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return answer({ error: "Not authenticated" }, 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return answer({ error: "Not authenticated" }, 401);
  if (!pushConfig()) return answer({ error: PUSH_NOT_CONFIGURED }, 503);

  let body: { orgId?: unknown; subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
  try { body = await req.json(); } catch { return answer({ error: "Invalid JSON body" }, 400); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const endpoint = body.subscription?.endpoint;
  const p256dh = body.subscription?.keys?.p256dh;
  const auth = body.subscription?.keys?.auth;
  if (!orgId) return answer({ error: "orgId is required" }, 400);
  if (!validEndpoint(endpoint) || !validKey(p256dh) || !validKey(auth)) {
    return answer({ error: "That is not a browser push subscription." }, 400);
  }

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return answer({ error: "Couldn't confirm your membership — try again." }, 503);
  if (!member) return answer({ error: "Not an active member of this organization." }, 403);

  // The endpoint is this browser's: whoever held it before (an earlier
  // subscription of the caller's, or another person who turned notifications
  // on in this browser) is replaced. Zero rows matched is the usual case.
  const cleared = await checkedWrite(supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", endpoint).select("id"));
  if (!cleared.ok && cleared.code === "db") {
    if (cleared.pgCode && isMissingSchemaError({ message: cleared.error, code: cleared.pgCode })) return answer({ error: PUSH_TABLE_MISSING }, 503);
    return answer({ error: cleared.error }, 500);
  }

  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
  const { error: insErr } = await supabaseAdmin
    .from("push_subscriptions")
    .insert({ user_id: user.id, org_id: orgId, endpoint, p256dh, auth, user_agent: userAgent })
    .select("id")
    .single();
  if (insErr) {
    if (isMissingSchemaError(insErr)) return answer({ error: PUSH_TABLE_MISSING }, 503);
    if (insErr.code === "23505") {
      // a second tab registered the same endpoint a moment ago
      const { data: held } = await supabaseAdmin.from("push_subscriptions").select("user_id").eq("endpoint", endpoint).maybeSingle();
      if ((held as { user_id?: string } | null)?.user_id === user.id) return answer({ ok: true });
      return answer({ error: "This browser was registered at the same moment by someone else — try again." }, 409);
    }
    return answer({ error: "The device could not be registered — try again." }, 500);
  }
  return answer({ ok: true });
}
