import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Authorize the KEY, not just the session. Every sensitive R2 key is
  // orgs/<orgId>/… — require the caller to be an active member of that org, or
  // any authenticated user could sign a URL for any key they can guess (IDOR /
  // cross-tenant read). Non-org-prefixed keys keep their prior behavior.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (orgMatch) {
    const { data: member } = await supabaseAdmin
      .from("org_members")
      .select("uid")
      .eq("org_id", orgMatch[1])
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
    }
  }

  const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
  });

  const url = await getSignedUrl(r2, command, { expiresIn });

  return NextResponse.json({ url });
}
