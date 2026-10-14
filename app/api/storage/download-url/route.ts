import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { canServeContent, controllerBypassDecided, isControllerPrincipal, type Principal } from "@/lib/permissions";
import { assertSafeStorageKey } from "@/lib/storageKey";
import { resolvePresignedLifetime } from "@/lib/presignedLifetime";
import { presignedGetDisposition, wantsInline } from "@/lib/presignedDisposition";
import { memberDownloadDenied, type DownloadDenyIndex } from "@/lib/downloadDeny";
import { loadReaderPrincipal, loadContainerAclChain, BrokenAclChainError } from "@/lib/docFileServer";
import { normalizeRoles } from "@/lib/roleCapabilities";
import type { AccessControl, NodeVisibility, Role } from "@/types/schema";

/** KACL-5: the access check could not be made (a lookup failed). */
const ACCESS_UNVERIFIED = "Couldn't verify your access to this file — try again.";

type KeyDoc = {
  id: string;
  org_id: string | null;
  visibility: string | null;
  acl: unknown;
  acl_index: unknown;
  owner_user_id: string | null;
  collection_id: string | null;
  library_id: string | null;
  is_private?: boolean | null;
  scope?: string | null;
  created_by?: string | null;
};

/** The reader in the document's workspace (lib/docFileServer
 *  loadReaderPrincipal, which throws when the membership or the teams cannot
 *  be read). DEC-43 (I-12 review fix): a CONTROLLER is still answered when
 *  only their teams could not be read — teams decide nothing for the
 *  controller tier here, and the explicit download deny below reads the
 *  member's own teams and fails closed on its own. Anyone else's unreadable
 *  membership or teams still throws (closed, 503). */
async function loadGatePrincipal(orgId: string, uid: string): Promise<Principal | null> {
  try {
    return await loadReaderPrincipal(orgId, uid);
  } catch (e) {
    const { data: mem, error } = await supabaseAdmin.from("org_members").select("role, roles")
      .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle();
    if (error || !mem) throw e;
    const m = mem as { role?: string | null; roles?: unknown };
    const p: Principal = {
      uid, role: (m.role as Role) ?? "Viewer", roles: normalizeRoles(m.roles, m.role), orgId, teamIds: [], isActiveMember: true,
    };
    if (!isControllerPrincipal(p)) throw e;
    return p;
  }
}

/** Every document that names this key — as a revision's rendered file
 *  (file_url) or its native source (source_file_key) — in lookup order. Two
 *  exact-equality lookups, never a PostgREST .or() string (assertSafeStorageKey
 *  admits commas and parentheses; the storage delete route's pattern). A
 *  database without the source column (42703 / PGRST204) has only the first.
 *  THROWS on any other lookup error. */
async function documentsNamingKey(path: string): Promise<string[]> {
  const ids: string[] = [];
  for (const col of ["file_url", "source_file_key"] as const) {
    const { data, error } = await supabaseAdmin
      .from("document_versions").select("record_id").eq(col, path).limit(25);
    if (error) {
      const code = (error as { code?: string }).code;
      if (col === "source_file_key" && (code === "42703" || code === "PGRST204")) break;
      throw new Error(`the file's document could not be looked up: ${error.message}`);
    }
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{ record_id?: string | null }>;
    for (const r of rows) if (r.record_id && !ids.includes(r.record_id)) ids.push(r.record_id);
  }
  return ids;
}

/** KACL-5: may this member be handed a URL for this org key? `null` = yes
 *  (or no document is behind the key); otherwise the refusal to send.
 *  The documents naming the key are judged in turn and the first one that
 *  serves the caller serves the bytes (they are the same bytes; a clone that
 *  shares a revision file is read through either). For each: the one read
 *  predicate over its full chain (a private draft is its creator's alone —
 *  IEDGE-12, the seam's rule); DEC-43's record when only the controller
 *  tier served it (unless the effective-owner cascade would have); GAP-15 /
 *  DEC-7's cascade when the ACL refuses; then the explicit download deny,
 *  which binds everyone (lib/downloadDeny — the share routes' rule too).
 *  DEC-43 (review fix): a controller is answered before the chain, as
 *  readableControlledDocIds answers one before the landscape — a chain that
 *  is broken or cannot be read does not refuse a controller; the read is
 *  recorded (CONTROLLER_RESTRICTED_READ, `chain_unverified`). */
async function documentKeyGate(
  keyOrg: string,
  path: string,
  user: { id: string; email: string | null },
): Promise<NextResponse | null> {
  const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });
  try {
    const docIds = await documentsNamingKey(path);
    if (docIds.length === 0) return null; // no record behind the key
    const docs: KeyDoc[] = [];
    for (const id of docIds) {
      const { data, error } = await supabaseAdmin
        .from("documents")
        .select("id, visibility, acl, acl_index, org_id, owner_user_id, collection_id, library_id, is_private, scope, created_by")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`the file's document could not be read: ${error.message}`);
      if (data) docs.push({ ...(data as KeyDoc), id: ((data as { id?: string }).id ?? id) });
    }
    // A version naming a document that is gone: no record behind the key.
    if (docs.length === 0) return null;

    const principals = new Map<string, Principal | null>();
    let refusal: { error: string; status: number } = { error: "Not authorized for this document", status: 403 };
    for (const doc of docs) {
      // Judged in the document's own workspace (a document of another
      // workspace than the key's prefix needs an active membership there).
      const orgId = doc.org_id ?? keyOrg;
      if (!principals.has(orgId)) principals.set(orgId, await loadGatePrincipal(orgId, user.id));
      const principal = principals.get(orgId) ?? null;
      if (!principal) continue;
      const visibility: NodeVisibility = doc.visibility === "private" || doc.visibility === "hidden" ? doc.visibility : "normal";
      // IEDGE-12: a private draft is its creator's alone (controllers still
      // read it, recorded below) — the seam's rule, in the one predicate.
      const privateDraft = doc.is_private === true || doc.scope === "private" ? { createdBy: doc.created_by ?? null } : null;
      let containerChain: Array<AccessControl | undefined> | null = null;
      let chainUnverified: string | null = null;
      try {
        containerChain = await loadContainerAclChain(orgId, { libraryId: doc.library_id, collectionId: doc.collection_id });
      } catch (e) {
        if (isControllerPrincipal(principal)) {
          // DEC-43: never dropped — served by the tier and recorded below.
          chainUnverified = e instanceof BrokenAclChainError ? e.message : "the folder chain could not be read";
        } else if (e instanceof BrokenAclChainError) {
          // A rung that does not exist: the decision cannot be made — say
          // so (permanent until a controller repairs the chain), never serve.
          refusal = { error: e.message, status: 409 };
          continue;
        } else {
          throw e;
        }
      }
      if (containerChain === null) {
        // DEC-43: the controller tier alone decided — the chain could not be
        // evaluated, so the read is recorded whoever owns the document (a
        // check not made records rather than skips). Best-effort.
        await supabaseAdmin.from("audit_logs").insert({
          action: "CONTROLLER_RESTRICTED_READ",
          resource_type: "document",
          resource_id: doc.id,
          org_id: orgId,
          user_id: user.id,
          user_email: user.email ?? null,
          details: { path, visibility, roles: principal.roles, chain_unverified: chainUnverified },
        }).then(() => undefined, () => undefined);
      } else {
        const contentCheck = {
          principal,
          aclChain: [...containerChain, (doc.acl ?? undefined) as AccessControl | undefined],
          visibility,
          // GAP-15/DEC-7: ownership serves on its own, so an owner who is also
          // a controller is NOT a bypass read (DEC-43). The explicit document
          // owner is authoritative here (user_is_effective_owner says the
          // same); the folder / library / team cascade is asked below, before
          // any audit row is written.
          effectiveOwnerUserId: (doc.owner_user_id as string | null) ?? null,
          privateDraft,
        };
        const allowed = canServeContent(contentCheck);
        // DOCACL-3 / DEC-43: controllers are unscoped by design (the recovery
        // rail, DEC-2). The mitigation is a RECORD: when the bytes of a
        // restricted node are served ONLY because the caller is a controller,
        // write an audit row. Best-effort — a failed audit insert never blocks
        // the rail.
        if (allowed && controllerBypassDecided(contentCheck)) {
          // Ownership that would have served the bytes anyway leaves no row:
          // the same cascade the deny path consults. A lookup error records
          // the read rather than skipping it.
          const { data: isOwner } = await supabaseAdmin.rpc("user_is_effective_owner", {
            p_doc_owner: (doc.owner_user_id as string | null) ?? null,
            p_collection: (doc.collection_id as string | null) ?? null,
            p_library: (doc.library_id as string | null) ?? null,
            p_uid: user.id,
          });
          if (isOwner !== true) {
            await supabaseAdmin.from("audit_logs").insert({
              action: "CONTROLLER_RESTRICTED_READ",
              resource_type: "document",
              resource_id: doc.id,
              org_id: orgId,
              user_id: user.id,
              user_email: user.email ?? null,
              details: { path, visibility, roles: contentCheck.principal.roles },
            }).then(() => undefined, () => undefined);
          }
        }
        if (!allowed) {
          // GAP-15/DEC-7: ownership carries read access — the effective owner
          // (document → folder → library → team-supervisor cascade, resolved
          // by the same DB function the publish guard uses) may pull the bytes
          // of their own document — never another creator's private draft
          // (the seam's rule). A lookup error is a check not made (closed).
          if (privateDraft && privateDraft.createdBy !== user.id) continue;
          const { data: isOwner, error: ownerErr } = await supabaseAdmin.rpc("user_is_effective_owner", {
            p_doc_owner: (doc.owner_user_id as string | null) ?? null,
            p_collection: (doc.collection_id as string | null) ?? null,
            p_library: (doc.library_id as string | null) ?? null,
            p_uid: user.id,
          });
          if (ownerErr) throw new Error(`ownership could not be checked: ${ownerErr.message}`);
          if (isOwner !== true) continue;
        }
      }
      // Explicit DOWNLOAD deny rules bind here too — URL issuance is the
      // enforcement point for bytes, so an ACL "deny download" must not be
      // routable around via a hand-built request. acl_index is chain-
      // resolved, so inherited denies are covered. The rule is
      // lib/downloadDeny.ts — the one the public share routes apply to a
      // link's creator (SHR-3). KACL-5: a read error refuses (closed).
      const download = await memberDownloadDenied(supabaseAdmin, {
        orgId, uid: user.id, aclIndex: (doc.acl_index as DownloadDenyIndex) ?? null,
      });
      if (download.unreadable) throw new Error("the download rules could not be checked");
      if (download.denied) {
        refusal = { error: "Downloading this document is denied for your account", status: 403 };
        continue;
      }
      return null; // served
    }
    return refuse(refusal.error, refusal.status);
  } catch {
    // KACL-5 done-when 3: a key behind a record (or one whose record could
    // not be looked up) fails CLOSED — never a URL on a check not made.
    return refuse(ACCESS_UNVERIFIED, 503);
  }
}

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

  // EGR-4 / PKG-11 / DEC-44 §2: the URL's lifetime is the server's decision.
  // A presigned URL is a bearer capability nothing can revoke, so the window
  // it opens IS the control: absent → the default, garbage → 400 (never NaN
  // into the presigner), otherwise clamped to the shared ceiling. Decided
  // before any lookup so a bad request costs nothing.
  const lifetime = resolvePresignedLifetime(req.nextUrl.searchParams.get("expiresIn"));
  if (!lifetime.ok) {
    return NextResponse.json({ error: lifetime.reason }, { status: 400 });
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

    // KACL-5 / IEDGE-12: membership alone is never enough for a key that
    // belongs to a document. Every org key is resolved to EVERY document
    // that names it — as a revision's rendered file (file_url) or its native
    // source (source_file_key) — and the bytes are served only when the
    // caller may read one of them: lib/permissions canServeContent, the one
    // read predicate (read or download over the FULL library → folder
    // lineage → document chain, on every visibility — an allow-list or a deny
    // on a normal document, its folder or its library binds here exactly as
    // it binds the AI seam and the library page; a private draft is its
    // creator's alone). A key behind a record FAILS CLOSED: a lookup that
    // cannot be made answers 503, a chain with a rung that does not exist
    // answers 409 naming it — for anyone but a controller, who is answered
    // before the chain and recorded (DEC-43). Only a key with no document
    // behind it keeps the membership check alone (attachments, knowledge
    // uploads, logos — they have their own doors).
    const gate = await documentKeyGate(orgMatch[1], path, { id: user.id, email: user.email ?? null });
    if (gate) return gate;
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

  // SEC-7 / SEC-1 (DEC-49): the URL is an ATTACHMENT unless the caller asks
  // for inline (`?inline=1` — the in-app viewers) AND the key names a PDF or
  // a raster image; an inline URL also pins that Content-Type, so what the
  // uploader declared is never what the browser renders. The answer says
  // which it got, so a viewer never frames an attachment.
  const disposition = presignedGetDisposition(path, wantsInline(req.nextUrl.searchParams.get("inline")));
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
    ...disposition.overrides,
  });

  const url = await getSignedUrl(r2, command, { expiresIn: lifetime.seconds });

  // The payload IS a bearer credential: never cacheable (XEDGE-6 — the
  // service worker refuses no-store and every /api/ response anyway; the
  // header is the contract every other cache honours). `expiresIn` is what
  // was GRANTED, so a caller can record the real window, not what it asked.
  return NextResponse.json(
    {
      url,
      expiresIn: lifetime.seconds,
      disposition: disposition.inline ? "inline" : "attachment",
      contentType: disposition.contentType,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
