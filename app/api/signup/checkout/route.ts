// POST /api/signup/checkout { company, name, email, plan }
//
// The only way to start a workspace: checks the company name and email are
// new and opens the payment page. Nothing is made until the payment goes
// through (lib/workspaceSignupServer). Public, so attempts are capped per
// network per hour (signup_attempts), which also slows anyone testing
// which emails have accounts.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { publicOrigin } from "@/lib/publicOrigin";
import { startCheckout, SignupError } from "@/lib/workspaceSignupServer";

export const runtime = "nodejs";

const MAX_PER_HOUR = 8;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (ip !== "unknown") {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error } = await supabaseAdmin.from("signup_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", since);
    if (!error && (count ?? 0) >= MAX_PER_HOUR) return NextResponse.json({ error: "Too many tries from this network. Wait an hour and try again." }, { status: 429 });
  }
  const body = await req.json().catch(() => ({})) as { company?: string; name?: string; email?: string; plan?: string };
  await supabaseAdmin.from("signup_attempts").insert({ ip, email: String(body.email ?? "").slice(0, 254) || null, outcome: "checkout" }).then(() => undefined, () => undefined);
  try {
    const { url } = await startCheckout({ company: body.company ?? "", name: body.name ?? "", email: body.email ?? "", plan: body.plan ?? "", origin: publicOrigin() || new URL(req.url).origin });
    return NextResponse.json({ url });
  } catch (e) {
    const status = e instanceof SignupError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
