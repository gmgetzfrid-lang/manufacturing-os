import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";

export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let path = "";
  try { path = String(((await req.json()) as { path?: unknown })?.path ?? ""); } catch { /* checked below */ }
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // Authorize the KEY, not just the session. Deleting is destructive, so:
  //   * the caller's own avatar folder (avatars/<uid>/) is theirs to clear;
  //   * orgs/<orgId>/… needs an active member of that org who is Admin or
  //     Doc Control, or the caller's own private folders in it;
  //   * any other key is refused.
  // Without this any member (or any signed-in user, for other keys) could
  // delete any stored file, released drawings included.
  const ownAvatar = path.startsWith(`avatars/${user.id}/`);
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (!ownAvatar) {
    if (!orgMatch) {
      return NextResponse.json({ error: "You can't delete that file." }, { status: 403 });
    }
    const orgId = orgMatch[1];
    const { data: member } = await supabaseAdmin
      .from("org_members")
      .select("role, roles")
      .eq("org_id", orgId)
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
    }
    const roles = [member.role as string, ...(((member.roles as string[] | null) ?? []))];
    const controller = roles.includes("Admin") || roles.includes("DocCtrl");
    const ownFolder =
      path.startsWith(`orgs/${orgId}/user_private/${user.id}/`) ||
      path.startsWith(`orgs/${orgId}/chat/pending/${user.id}/`);
    // A work order package's working copies (photos, files, signed scans:
    // orgs/<org>/packages/<project>/...) are deleted by the people on that
    // project once the package is filed to the network drive.
    let onPackageProject = false;
    const pkg = path.match(/^orgs\/[0-9a-fA-F-]{36}\/packages\/([0-9a-fA-F-]{36})\//);
    if (!controller && pkg) {
      const [{ data: proj }, { data: pm }] = await Promise.all([
        supabaseAdmin.from("projects").select("owner_user_id, org_id").eq("id", pkg[1]).maybeSingle(),
        supabaseAdmin.from("project_members").select("user_id").eq("project_id", pkg[1]).eq("user_id", user.id).maybeSingle(),
      ]);
      onPackageProject = !!proj && String(proj.org_id) === orgId && (String(proj.owner_user_id ?? "") === user.id || !!pm);
    }
    if (!controller && !ownFolder && !onPackageProject) {
      return NextResponse.json({ error: "Only Admin or Doc Control can delete this file." }, { status: 403 });
    }
  }

  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));

  return NextResponse.json({ ok: true });
}
