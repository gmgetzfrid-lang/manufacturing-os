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
// Only a browser push service's endpoint is stored (fix pass — the review's
// blocker): an https URL on a push service's own host, default port, no
// user-info (lib/push/endpoints.ts pushEndpointAllowed). Anything else is
// refused as "not a browser push subscription"; the sender re-checks before
// every send. This route is the table's only writer once 20261211 is pasted
// (it drops the own-row INSERT policy).
//
// One browser profile has one push endpoint. When a second person turns
// notifications on in the same browser, the endpoint is theirs from then on:
// the row for it is handed over in ONE conditional update (the takeover
// needs the service role) — and only when the stored row carries the same
// p256dh and auth keys the caller presents. Those keys are secret to the
// browser that holds the live subscription, so a match proves the caller is
// at that browser; knowing someone's endpoint alone takes nothing over (an
// endpoint stored under other keys answers 409). Nothing is deleted first, so
// a failed write leaves the previous registration as it was.
//
// A person keeps at most PUSH_DEVICE_CAP registrations: adding one past the
// cap removes their oldest.
//
// Before 20260804 is applied the POST answers 503 and says so; the page shows
// it and nothing else changes.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";
import { pushConfig } from "@/lib/push/sendPush";
import { PUSH_DEVICE_CAP, PUSH_KEYS_MISMATCH, pushEndpointAllowed } from "@/lib/push/endpoints";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const PUSH_TABLE_MISSING =
  "Device notifications need a database update that has not been applied yet (20260804_push_subscriptions.sql). Nothing was changed.";
const PUSH_NOT_CONFIGURED = "Device notifications are not set up on this server yet.";

const KEYS_MISMATCH_TEXT =
  "This browser's notification registration could not be confirmed — try again to start a fresh one.";

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
  if (!pushEndpointAllowed(endpoint) || !validKey(p256dh) || !validKey(auth)) {
    return answer({ error: "That is not a browser push subscription." }, 400);
  }

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return answer({ error: "Couldn't confirm your membership — try again." }, 503);
  if (!member) return answer({ error: "Not an active member of this organization." }, 403);

  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
  // A fresh opt-in: created_at is now (the sender's PUSH_OPT_IN_SINCE rule and
  // the device cap read it), and the new holder has had no push yet.
  const holder = { user_id: user.id, org_id: orgId, user_agent: userAgent, created_at: new Date().toISOString(), last_reminded_at: null };

  // 1) This browser's endpoint, already stored under THESE keys (the caller's
  //    own earlier registration, or another person's in this same browser):
  //    handed to the caller in one conditional update.
  const taken = await checkedWrite(supabaseAdmin
    .from("push_subscriptions")
    .update(holder)
    .eq("endpoint", endpoint)
    .eq("p256dh", p256dh)
    .eq("auth", auth)
    .select("id"));
  if (!taken.ok && taken.code === "db") {
    if (taken.pgCode && isMissingSchemaError({ message: taken.error, code: taken.pgCode })) return answer({ error: PUSH_TABLE_MISSING }, 503);
    return answer({ error: "The device could not be registered — try again." }, 500);
  }

  if (!taken.ok) {
    // 2) Not stored under these keys: a new registration.
    const { error: insErr } = await supabaseAdmin
      .from("push_subscriptions")
      .insert({ ...holder, endpoint, p256dh, auth })
      .select("id")
      .single();
    if (insErr) {
      if (isMissingSchemaError(insErr)) return answer({ error: PUSH_TABLE_MISSING }, 503);
      if (insErr.code === "23505") {
        // The endpoint is stored already: a second tab of the caller's
        // registered it a moment ago (same keys — fine), or it is stored
        // under OTHER keys, which this caller has not shown it holds.
        const { data: held } = await supabaseAdmin
          .from("push_subscriptions").select("user_id, p256dh, auth").eq("endpoint", endpoint).maybeSingle();
        const h = held as { user_id?: string; p256dh?: string; auth?: string } | null;
        if (h && h.user_id === user.id && h.p256dh === p256dh && h.auth === auth) return answer({ ok: true });
        return answer({ error: KEYS_MISMATCH_TEXT, code: PUSH_KEYS_MISMATCH }, 409);
      }
      return answer({ error: "The device could not be registered — try again." }, 500);
    }
  }

  // 3) At most PUSH_DEVICE_CAP registrations per person: the oldest go.
  //    Best-effort — the sender reads no more than the cap either way.
  await keepNewestDevices(user.id, endpoint);
  return answer({ ok: true });
}

/** Remove a person's registrations past their PUSH_DEVICE_CAP newest (never
 *  the one just registered). Never throws; a failure is logged. */
async function keepNewestDevices(uid: string, keep: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from("push_subscriptions").select("id, endpoint, created_at").eq("user_id", uid).limit(1000);
    if (error) { console.warn(`[push] the device cap could not be checked (${error.message})`); return; }
    const rows = [...((data as Array<{ id: string; endpoint: string; created_at: string | null }> | null) ?? [])]
      .sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
    const current = rows.filter((r) => r.endpoint === keep);
    const others = rows.filter((r) => r.endpoint !== keep);
    const extra = others.slice(Math.max(0, PUSH_DEVICE_CAP - current.length)).map((r) => r.id);
    if (extra.length === 0) return;
    const del = await checkedWrite(supabaseAdmin.from("push_subscriptions").delete().in("id", extra).eq("user_id", uid).select("id"));
    if (!del.ok && del.code === "db") console.warn(`[push] ${extra.length} registration(s) past the device cap could not be removed: ${del.error}`);
  } catch (e) {
    console.warn(`[push] the device cap could not be applied: ${(e as Error)?.message ?? e}`);
  }
}
