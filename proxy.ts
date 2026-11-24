// proxy.ts — runs before every /api request.
//
// Refuses requests that change something (POST, PUT, PATCH, DELETE) when
// the signed-in user's workspace has no active subscription and its trial
// has ended. Reading, paying, exporting, signing in and leaving stay open
// (lib/subscriptionGuard.ts). The app shows the same thing on screen
// (components/subscription/SubscriptionGate.tsx), and the database refuses
// direct changes (supabase/migrations/20261124_subscription_enforced.sql).
//
// If the check itself fails (the database can't be reached), the request
// goes through: a hiccup must never stop a paying workspace.

import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { anyAccess, bearerUid, LAPSED_MESSAGE, needsAccessCheck, type OrgBilling } from "@/lib/subscriptionGuard";

const TTL = 60_000;
const seen = new Map<string, { at: number; ok: boolean }>();

async function userHasAccess(uid: string): Promise<boolean> {
  const hit = seen.get(uid);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  const { data: members, error: e1 } = await supabaseAdmin
    .from("org_members").select("org_id").eq("uid", uid).limit(100);
  if (e1) throw e1;
  const ids = [...new Set(((members ?? []) as { org_id: string }[]).map((m) => m.org_id).filter(Boolean))];
  let orgs: OrgBilling[] = [];
  if (ids.length) {
    const { data, error: e2 } = await supabaseAdmin
      .from("orgs").select("subscription_status, trial_ends_at").in("id", ids);
    if (e2) throw e2;
    orgs = (data ?? []) as OrgBilling[];
  }
  const ok = anyAccess(orgs);
  if (seen.size > 5000) seen.clear();
  seen.set(uid, { at: Date.now(), ok });
  return ok;
}

export async function proxy(req: NextRequest) {
  if (!needsAccessCheck(req.method, req.nextUrl.pathname)) return NextResponse.next();
  const uid = bearerUid(req.headers.get("authorization"));
  if (!uid) return NextResponse.next();
  try {
    if (await userHasAccess(uid)) return NextResponse.next();
  } catch {
    return NextResponse.next();
  }
  return NextResponse.json({ error: LAPSED_MESSAGE, code: "subscription_required" }, { status: 402 });
}

export const config = { matcher: "/api/:path*" };
