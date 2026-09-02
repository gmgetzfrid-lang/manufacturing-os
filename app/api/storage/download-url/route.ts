import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { canDiscover } from "@/lib/permissions";
import { normalizeRoles } from "@/lib/roleCapabilities";
import { assertSafeStorageKey } from "@/lib/storageKey";
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
  // Refuse traversal / control-byte keys before the org-prefix gate reasons
  // about them — a key like orgs/<mine>/../../orgs/<other>/x would otherwise
  // authorize against my prefix while naming something else.
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

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
          .select("visibility, acl, acl_index, org_id, owner_user_id, collection_id, library_id")
          .eq("id", docId)
          .maybeSingle();
        const visibility = (doc?.visibility as NodeVisibility | undefined) ?? "normal";
        if (doc && (visibility === "private" || visibility === "hidden")) {
          const [{ data: mem }, { data: teams }] = await Promise.all([
            supabaseAdmin.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
            supabaseAdmin.from("team_members").select("team_id").eq("uid", user.id),
          ]);
          const allowed = canDiscover({
            principal: {
              uid: user.id,
              role: (mem?.role as Role) ?? "Viewer",
              roles: normalizeRoles(mem?.roles, mem?.role),
              orgId,
              teamIds: (teams ?? []).map((t) => t.team_id as string),
              isActiveMember: true,
            },
            aclChain: [doc.acl as AccessControl | undefined],
            visibility,
          });
          if (!allowed) {
            // GAP-15/DEC-7: ownership carries read access — the effective
            // owner (document → folder → library → team-supervisor cascade,
            // resolved by the same DB function the publish guard uses) may
            // pull the bytes of their own private-library documents.
            const { data: isOwner } = await supabaseAdmin.rpc("user_is_effective_owner", {
              p_doc_owner: (doc.owner_user_id as string | null) ?? null,
              p_collection: (doc.collection_id as string | null) ?? null,
              p_library: (doc.library_id as string | null) ?? null,
              p_uid: user.id,
            });
            if (isOwner !== true) {
              return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });
            }
          }
        }
        // Explicit DOWNLOAD deny rules bind here too — URL issuance is the
        // enforcement point for bytes, so an ACL "deny download" must not be
        // routable around via a hand-built request. acl_index is
        // chain-resolved, so inherited denies are covered.
        const idx = (doc?.acl_index as { deny?: { users?: Record<string, string[]>; roles?: Record<string, string[]>; teams?: Record<string, string[]> } } | null) ?? null;
        const dl = idx?.deny;
        if (doc && dl && ((dl.users?.download?.length ?? 0) > 0 || (dl.roles?.download?.length ?? 0) > 0 || (dl.teams?.download?.length ?? 0) > 0)) {
          const [{ data: mem2 }, { data: teams2 }] = await Promise.all([
            supabaseAdmin.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
            supabaseAdmin.from("team_members").select("team_id").eq("uid", user.id),
          ]);
          // `??` only caught null: a row with roles: [] dropped the headline and
          // every role-based download deny stopped matching. normalizeRoles
          // seeds from the headline unconditionally.
          const heldRoles: string[] = normalizeRoles(mem2?.roles, mem2?.role);
          if (heldRoles.length === 0) heldRoles.push("Viewer");
          const teamIds2 = (teams2 ?? []).map((t) => t.team_id as string);
          const denied =
            (dl.users?.download ?? []).includes(user.id) ||
            heldRoles.some((r) => (dl.roles?.download ?? []).includes(r)) ||
            teamIds2.some((t) => (dl.teams?.download ?? []).includes(t));
          if (denied) {
            return NextResponse.json({ error: "Downloading this document is denied for your account" }, { status: 403 });
          }
        }
      }
    } catch {
      /* fail open to the membership check above — never break a valid download */
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
