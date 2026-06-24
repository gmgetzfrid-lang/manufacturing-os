// GET /api/storage/resolve?path=<r2 key>
//
// The archive-aware file opener. Given a storage key it returns EITHER a signed
// URL (binary present) OR archived metadata (binary shed for space) so the UI
// can prompt the user — any user — to provide the named offline archive instead
// of showing a broken link.
//
//   { archived:false, url }                              → open it normally
//   { archived:true, archiveId, root, fileName }         → prompt: provide
//                                                          <root>/data/<id>.zip

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const path = req.nextUrl.searchParams.get("path") || "";
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });

  // Which version owns this binary? Drives archive status + org membership check.
  const { data: ver } = await supabaseAdmin
    .from("document_versions")
    .select("org_id, archived_at, archive_id, created_at")
    .eq("file_url", path)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const v = ver as { org_id?: string; archived_at?: string | null; archive_id?: string | null } | null;
  // Attribute the key to an org: prefer the document_versions row, else parse the
  // `orgs/<orgId>/…` prefix — so the membership gate below ALWAYS applies, even
  // for ticket-attachment keys that aren't in document_versions (no auth bypass).
  const orgId = v?.org_id ?? path.match(/^orgs\/([0-9a-fA-F-]{36})\//)?.[1];
  const fileName = path.split("/").pop() || "file";

  // If we can attribute the file to an org, require the caller to be a member.
  if (orgId) {
    const { data: m } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
    if (!m) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  }

  const rootFor = async (): Promise<string | null> => {
    if (!orgId) return null;
    const { data } = await supabaseAdmin.from("archive_settings").select("location_hint").eq("org_id", orgId).maybeSingle();
    return (data as { location_hint?: string | null } | null)?.location_hint ?? null;
  };

  // Explicitly shed for space.
  if (v?.archived_at) {
    return NextResponse.json({ archived: true, archiveId: v.archive_id ?? null, root: await rootFor(), fileName });
  }

  // Otherwise sign it — but if the object is actually gone from R2, fall back to
  // the archived prompt so the user still has a path forward.
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }), { expiresIn: 3600 });
    return NextResponse.json({ archived: false, url });
  } catch {
    return NextResponse.json({ archived: true, missing: true, archiveId: v?.archive_id ?? null, root: await rootFor(), fileName });
  }
}
