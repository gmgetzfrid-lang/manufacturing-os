// GET /api/data-export/structured?orgId=...
//
// Streams the full export envelope as a downloadable JSON file.
// Caller must be an Admin or Manager of the requested org. Authorization
// is checked server-side against org_members using the user's session token.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runOrgExport } from "@/lib/dataExport";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Server is missing Supabase credentials" }, { status: 500 });
  }

  // Pull the bearer token from the user's session
  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "Missing access token" }, { status: 401 });
  }

  // Resolve the user from their token
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = userData.user;

  // Pick the org out of the query string and verify membership + role
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: member } = await admin
    .from("org_members")
    .select("role, status")
    .eq("org_id", orgId)
    .eq("uid", user.id)
    .maybeSingle();
  const role = (member as { role?: string; status?: string } | null)?.role;
  const status = (member as { status?: string } | null)?.status;
  if (status !== "active") return NextResponse.json({ error: "Not a member of this org" }, { status: 403 });
  if (!["Admin", "Manager", "DocCtrl"].includes(role || "")) {
    return NextResponse.json({ error: "Only Admin / Manager / DocCtrl can export org data" }, { status: 403 });
  }

  // Run the export
  const envelope = await runOrgExport({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    exporterUserId: user.id,
    exporterEmail: user.email || "",
  });

  // Stream as a downloadable JSON file
  const body = JSON.stringify(envelope, null, 2);
  const filename = `manufacturing-os-export-${(envelope.manifest.orgName || orgId).replace(/[^\w.\-]+/g, "_")}-${envelope.manifest.exportedAt.slice(0, 10)}.json`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
