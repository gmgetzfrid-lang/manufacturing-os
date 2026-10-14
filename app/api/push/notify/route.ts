// POST /api/push/notify — the browser half of emit()'s push leg
// (notifications Round G, N10 PUSH — GAP-205, OS-9).
//
// emit() runs in the browser for most producers (a hold placed, a checkout
// force-released, an acknowledgment or sign-off requested), and the browser
// holds neither the VAPID private key nor the right to read another
// person's device rows. After its bell and email legs it posts the event
// here (lib/notify/dispatch.ts browserPushRequest — fire-and-forget, the
// caller never waits) and this route calls the sender,
// lib/push/sendPush.ts sendPushSafe, with the caller as the writer.
//
// What the caller can cause is bounded by what it already did: a person is
// pushed only for a bell row of this push-worthy kind, about this resource,
// naming the CALLER as its actor, written to them in the last two minutes
// and dated no later than now plus a five-minute clock margin, and only if
// they are an active member of this workspace. 20261160, once pasted,
// stamps every browser row with its writer and the time and skips a
// recipient who is not a member; the sender checks the date and the
// membership itself (fix pass 3), so both hold before that paste too. Never
// for a redacted notice, at most PUSH_WRITER_CAP times per writer and
// person in ten minutes, once per row
// per device, and only if that person turned a device on and left
// push_enabled on. The push says only the kind (PUSH_TITLES), and goes only
// to a push service's own host (lib/push/endpoints.ts). The answer never
// says who was pushed, and (fix pass) it never waits for the sends: the
// route answers once the caller is known to be a member, and the sends run
// after the response (next/server after()), so how long the push services
// took cannot be read from the answer's timing.
//
// Off without VAPID keys: 204 before any database call, so a deployment
// that never set push up pays one cheap request per push-worthy notice and
// behaves exactly as before.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kindMeta } from "@/lib/notificationKinds";
import type { NotificationKind } from "@/lib/inAppNotifications";
import { sendPushSafe, pushConfig, PUSH_MAX_RECIPIENTS } from "@/lib/push/sendPush";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  if (!pushConfig()) return new NextResponse(null, { status: 204, headers: NO_STORE });

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return answer({ error: "Not authenticated" }, 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return answer({ error: "Not authenticated" }, 401);

  let body: { orgId?: unknown; kind?: unknown; resourceId?: unknown; recipients?: unknown };
  try { body = await req.json(); } catch { return answer({ error: "Invalid JSON body" }, 400); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
  const recipients = Array.isArray(body.recipients)
    ? [...new Set((body.recipients as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : null;
  if (!orgId || !kind || !resourceId || recipients === null) return answer({ error: "orgId, kind, resourceId and recipients are required" }, 400);
  if (kindMeta(kind)?.pushWorthy !== true) return answer({ error: "That notification kind is not sent as a push." }, 400);
  if (recipients.length > PUSH_MAX_RECIPIENTS) return answer({ error: `Up to ${PUSH_MAX_RECIPIENTS} recipients per request (got ${recipients.length}).` }, 400);

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return answer({ error: "Couldn't confirm your membership — try again." }, 503);
  if (!member) return answer({ error: "Not an active member of this organization." }, 403);

  // After the response (the answer's timing says nothing about the sends).
  // Never throws; the outcome (who was pushed) stays on the server.
  const writerUid = user.id;
  after(async () => {
    await sendPushSafe({ orgId, kind: kind as NotificationKind, resourceId, recipients, writerUid });
  });
  return answer({ ok: true });
}
