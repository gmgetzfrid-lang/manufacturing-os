// POST /api/push/subscribe
//
// Stores a browser's Web Push subscription for the authenticated user, so the
// reminder cron can deliver notifications even when the app is closed. The
// caller passes its Supabase access token as a Bearer header; we verify the
// user with the anon client, then upsert with the service role (keyed on the
// unique endpoint, so re-subscribing the same browser just refreshes it).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function userIdFromRequest(req: NextRequest): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !url || !anon) return null;
  const client = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data } = await client.auth.getUser();
  return data?.user?.id ?? null;
}

export async function POST(req: NextRequest) {
  if (!url || !service) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const userId = await userIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    orgId?: string;
  } | null;
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { error } = await admin.from("push_subscriptions").upsert(
    {
      user_id: userId,
      org_id: body?.orgId ?? null,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: req.headers.get("user-agent") ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
