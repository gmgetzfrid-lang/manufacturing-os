import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { canDiscover } from "@/lib/permissions";
import type { AccessControl, NodeVisibility, Role } from "@/types/schema";

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

    // Defense-in-depth (finding H7): membership alone isn't enough for a
    // restricted document. If this key belongs to a document that is private
    // or hidden AND the caller can't discover it under its ACL, deny — else a
    // member could read the bytes of a doc the ACL hides from them. This only
    // ever tightens access for private/hidden docs; normal docs are unaffected.
    // Fail OPEN to the membership check on any lookup error, so a legitimate
    // download is never broken by this extra guard.
    try {
      const orgId = orgMatch[1];
      const { data: ver } = await supabaseAdmin
        .from("document_versions")
        .select("record_id")
        .eq("file_url", path)
        .limit(1)
        .maybeSingle();
      const docId = (ver?.record_id as string | undefined) ?? undefined;
      if (docId) {
        const { data: doc } = await supabaseAdmin
          .from("documents")
          .select("visibility, acl, org_id")
          .eq("id", docId)
          .maybeSingle();
        const visibility = (doc?.visibility as NodeVisibility | undefined) ?? "normal";
        if (doc && (visibility === "private" || visibility === "hidden")) {
          const [{ data: mem }, { data: teams }] = await Promise.all([
            supabaseAdmin.from("org_members").select("role").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
            supabaseAdmin.from("team_members").select("team_id").eq("uid", user.id),
          ]);
          const allowed = canDiscover({
            principal: {
              uid: user.id,
              role: (mem?.role as Role) ?? "Viewer",
              orgId,
              teamIds: (teams ?? []).map((t) => t.team_id as string),
              isActiveMember: true,
            },
            aclChain: [doc.acl as AccessControl | undefined],
            visibility,
          });
          if (!allowed) {
            return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });
          }
        }
      }
    } catch {
      /* fail open to the membership check above — never break a valid download */
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
