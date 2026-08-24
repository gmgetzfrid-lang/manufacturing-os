import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, applyEmailLookup } from "@/lib/identity";

// This public, unauthenticated endpoint was the one door in the auth pair with
// no rate limit — its neighbour /api/auth/signup carries the full
// signup_attempts throttle. Unthrottled, it is an org-name existence oracle
// (404 vs 200) and a request-spam vector. Mirror the signup pattern exactly,
// sharing the same per-IP bucket (EGRESS-5 / DEC-19).
const REQUEST_ACCESS_MAX_PER_HOUR = 8;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

async function requestAccessRateLimited(ip: string): Promise<boolean> {
  if (ip === "unknown") return false; // don't punish everyone if IP is missing
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", since);
  if (error) return false; // table absent / transient — fail open
  return (count ?? 0) >= REQUEST_ACCESS_MAX_PER_HOUR;
}

async function recordAttempt(ip: string, email: string | null, outcome: string): Promise<void> {
  await supabaseAdmin.from("signup_attempts").insert({ ip, email, outcome })
    .then(() => undefined, () => undefined);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  try {
    if (await requestAccessRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many access requests from this network. Please wait a while and try again." },
        { status: 429 },
      );
    }

    const { displayName, email: rawEmail, orgName } = await req.json();

    if (!displayName || !rawEmail || !orgName) {
      await recordAttempt(ip, null, "error");
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }
    // One canonical casing for identity (IDENT-3).
    const email = normalizeEmail(String(rawEmail));

    // Consume one attempt from the per-IP window BEFORE the org lookup, so
    // repeated 404 org-name probing and 409 duplicate probing both count
    // against the limit rather than being free.
    await recordAttempt(ip, email, "request-access");

    // 1. Find the organization (case-insensitive)
    const { data: org } = await supabaseAdmin
      .from("orgs")
      .select("id, name")
      .ilike("name", orgName.trim())
      .maybeSingle();

    if (!org) {
      return NextResponse.json(
        { error: `No organization named "${orgName}" was found. Check spelling, or create a new organization if you're the first admin.` },
        { status: 404 }
      );
    }

    const orgId = (org as { id: string; name: string }).id;
    const orgRealName = (org as { id: string; name: string }).name;

    // 2. Check for duplicate pending request — case-insensitively (IDENT-3),
    // and refuse on a failed lookup rather than reading it as "no pending
    // request" and stacking a duplicate row.
    const { data: existingReqs, error: dupCheckError } = await applyEmailLookup(
      supabaseAdmin.from("access_requests").select("id, status"),
      "email",
      email
    )
      .eq("org_id", orgId)
      .eq("status", "pending")
      .limit(1);
    if (dupCheckError) {
      return NextResponse.json(
        { error: "Couldn't check for an existing request — please try again." },
        { status: 500 }
      );
    }
    const existingReq = existingReqs?.[0] ?? null;

    if (existingReq) {
      return NextResponse.json(
        { error: `You already have a pending request to join "${orgRealName}". Please wait for an admin to respond.` },
        { status: 409 }
      );
    }

    // 3. Insert request linked to the org
    const { error: insertError } = await supabaseAdmin.from("access_requests").insert({
      org_id: orgId,
      org_name: orgRealName,
      display_name: displayName,
      email,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      return NextResponse.json({ error: `Failed to submit request: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, orgName: orgRealName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected server error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
