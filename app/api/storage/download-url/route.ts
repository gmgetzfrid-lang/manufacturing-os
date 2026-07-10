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

  // ARCHIVE-AWARE: if this key's binary was shed to an offline space archive,
  // signing a URL would just 404 downstream. Answer with the archive identity
  // instead (HTTP 409) so the caller can prompt "provide <root>/data/<id>.zip"
  // — unaware callers treat 409 as their existing failure path. Indexed lookup
  // (document_versions_file_url_idx), one row, sub-ms.
  const { data: ver } = await supabaseAdmin
    .from("document_versions")
    .select("archive_id, archived_at")
    .eq("file_url", path)
    .not("archived_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (ver?.archived_at) {
    let root: string | null = null;
    if (orgMatch) {
      const { data: st } = await supabaseAdmin
        .from("archive_settings").select("location_hint")
        .eq("org_id", orgMatch[1]).maybeSingle();
      root = (st as { location_hint?: string | null } | null)?.location_hint ?? null;
    }
    return NextResponse.json(
      { archived: true, archiveId: (ver.archive_id as string | null) ?? null, root, fileName: path.split("/").pop() || "file" },
      { status: 409 },
    );
  }

  const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
  });

  const url = await getSignedUrl(r2, command, { expiresIn });

  return NextResponse.json({ url });
}
