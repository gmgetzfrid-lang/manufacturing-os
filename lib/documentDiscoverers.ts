// lib/documentDiscoverers.ts — SERVER-ONLY (service role).
//
// NEDGE-6 done-when 3 (notifications Round G, N9 — assigned by the integrator
// at the N5 merge): a server-side DISCOVER check for one document and a list
// of people. A notice about a hidden or private document names it in its
// title; the follow list, the named stakeholders and the role pools are
// resolved with no ACL consultation, so a member who can no longer discover
// the document still reads its number (and, for a hold, its reason) in the
// bell and the email body. The database's node_visible / doc_is_visible
// answer only for auth.uid(); the one evaluator that answers for ANOTHER
// person is lib/docFileServer.ts (loadReaderPrincipal, loadContainerAclChain)
// on the service role. This module is that evaluator, asked once per
// (document, people): who among `uids` may DISCOVER the document — the bar a
// member's own client applies (lib/permissions canDiscover) over the FULL
// library → folders → document chain, with the effective-owner cascade
// (GAP-15 / DEC-7) and the controller tier (DEC-43: controllers are
// unscoped). It answers; it does not filter anyone's notice by itself.
//
// Who wires it: the dispatcher (lib/notify/dispatch.ts, emit) is owned by the
// notifications dispatch package — dropping the non-discovering,
// non-controller recipients of a document-scoped event is its call to make,
// through this module on the server and POST /api/documents/discoverers from
// the browser. Recorded as NEDGE-6's residual with that owner.
//
// Fail-closed toward the caller: a membership, chain or document read that
// fails answers `ok: false` with the reason — never a guessed list. A chain
// that names a missing folder or library (BrokenAclChainError) is an
// answer too: nobody but the controllers can be shown to discover it.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  BrokenAclChainError, loadContainerAclChain, type ContainerAclChain,
} from "@/lib/docFileServer";
import { canDiscover, type Principal } from "@/lib/permissions";
import { normalizeRoles } from "@/lib/roleCapabilities";
import { runWithServerClient } from "@/lib/serverClientScope";
import type { AccessControl, NodeVisibility, Role } from "@/types/schema";

/** The most people one check answers for (one emit's audience is far below it). */
export const DISCOVERERS_MAX_UIDS = 500;

export type DiscoverersAnswer =
  | {
      ok: true;
      /** The people among `uids` who may discover the document, in input order. */
      discover: string[];
      /** The people who may not — or are not active members of the org. */
      withheld: string[];
      /** The document's visibility: a `normal` document with no ACL anywhere
       *  on its chain is discoverable by every active member. */
      visibility: NodeVisibility;
      /** The chain names a folder or library that no longer exists; only the
       *  controllers and the document's effective owner are answered. */
      brokenChain?: boolean;
    }
  | { ok: false; status: 404 | 503; error: string };

interface DocRow {
  id: string;
  library_id: string | null;
  collection_id: string | null;
  visibility: string | null;
  acl: unknown;
  owner_user_id: string | null;
  owner_name: string | null;
}

const visibilityOf = (v: string | null | undefined): NodeVisibility =>
  v === "private" || v === "hidden" ? v : "normal";

/** Pure: may `principal` discover the document, given its chain? */
export function principalDiscovers(
  principal: Principal,
  doc: { acl?: unknown; visibility?: string | null },
  containerChain: ContainerAclChain,
  effectiveOwnerUid: string | null,
): boolean {
  return canDiscover({
    principal,
    aclChain: [...containerChain, (doc.acl ?? undefined) as AccessControl | undefined],
    visibility: visibilityOf(doc.visibility),
    effectiveOwnerUserId: effectiveOwnerUid,
  });
}

/** The principals of `uids` who are ACTIVE members of `orgId` — the shape
 *  lib/docFileServer.ts loadReaderPrincipal builds (headline + additive
 *  roles, team ids), read in batches rather than two reads per person.
 *  Throws on a read error: a check that cannot see a membership must not
 *  guess. */
export async function loadPrincipals(orgId: string, uids: readonly string[]): Promise<Map<string, Principal>> {
  const out = new Map<string, Principal>();
  for (let i = 0; i < uids.length; i += 200) {
    const slice = uids.slice(i, i + 200);
    const [{ data: mems, error: memErr }, { data: teams, error: teamErr }] = await Promise.all([
      supabaseAdmin.from("org_members").select("uid, role, roles")
        .eq("org_id", orgId).eq("status", "active").in("uid", slice),
      supabaseAdmin.from("team_members").select("uid, team_id").in("uid", slice),
    ]);
    if (memErr || teamErr) throw new Error("The recipients' memberships could not be read.");
    const teamIds = new Map<string, string[]>();
    for (const t of ((teams ?? []) as Array<{ uid: string; team_id: string }>)) {
      const k = String(t.uid);
      teamIds.set(k, [...(teamIds.get(k) ?? []), String(t.team_id)]);
    }
    for (const m of ((mems ?? []) as Array<{ uid: string; role?: string | null; roles?: unknown }>)) {
      const uid = String(m.uid);
      out.set(uid, {
        uid,
        role: (m.role as Role) ?? "Viewer",
        roles: normalizeRoles(m.roles, m.role),
        orgId,
        teamIds: teamIds.get(uid) ?? [],
        isActiveMember: true,
      });
    }
  }
  return out;
}

/** Who among `uids` may discover `documentId` in `orgId`. */
export async function discoverersOfDocument(input: {
  orgId: string;
  documentId: string;
  uids: readonly string[];
}): Promise<DiscoverersAnswer> {
  const uids = [...new Set(input.uids.filter((u) => typeof u === "string" && u.length > 0))].slice(0, DISCOVERERS_MAX_UIDS);
  const { data, error } = await supabaseAdmin
    .from("documents")
    .select("id, library_id, collection_id, visibility, acl, owner_user_id, owner_name")
    .eq("org_id", input.orgId).eq("id", input.documentId).maybeSingle();
  if (error) return { ok: false, status: 503, error: "The document could not be read." };
  if (!data) return { ok: false, status: 404, error: "No such document in this organization." };
  const doc = data as DocRow;
  const visibility = visibilityOf(doc.visibility);

  let chain: ContainerAclChain = [];
  let brokenChain = false;
  try {
    chain = await loadContainerAclChain(input.orgId, { libraryId: doc.library_id, collectionId: doc.collection_id });
  } catch (e) {
    if (!(e instanceof BrokenAclChainError)) return { ok: false, status: 503, error: (e as Error).message };
    brokenChain = true;
  }

  // GAP-15 / DEC-7: ownership carries discovery — the effective owner
  // (document → folder → library → owning team's supervisor).
  let ownerUid: string | null = doc.owner_user_id ?? null;
  if (doc.library_id) {
    try {
      const { effectiveOwnerForDocument } = await import("@/lib/ownership");
      const eff = await runWithServerClient(supabaseAdmin, () => effectiveOwnerForDocument({
        ownerUserId: doc.owner_user_id, ownerName: doc.owner_name,
        collectionId: doc.collection_id, libraryId: doc.library_id as string, orgId: input.orgId,
      }));
      ownerUid = eff.userId ?? ownerUid;
    } catch {
      // the document's own owner column stands in
    }
  }

  let principals: Map<string, Principal>;
  try {
    principals = await loadPrincipals(input.orgId, uids);
  } catch (e) {
    return { ok: false, status: 503, error: (e as Error).message };
  }
  const discover: string[] = [];
  const withheld: string[] = [];
  for (const uid of uids) {
    const principal = principals.get(uid);
    if (!principal) { withheld.push(uid); continue; }
    const sees = brokenChain
      // A broken chain cannot be evaluated: only what needs no chain answers
      // (the controller tier, the effective owner).
      ? principalDiscovers(principal, { visibility: "hidden", acl: undefined }, [], ownerUid)
      : principalDiscovers(principal, doc, chain, ownerUid);
    (sees ? discover : withheld).push(uid);
  }
  return { ok: true, discover, withheld, visibility, ...(brokenChain ? { brokenChain: true } : {}) };
}
