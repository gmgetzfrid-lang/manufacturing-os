// Phase 6 severity sweep, Round A3 (no migration): DOCACL-4 (move re-indexes
// the subtree; folders are born chain-indexed), DOCACL-5 (bytes on read /
// download, never discover), DEL-6 (owner opens recert), DEL-8 (live owner
// names in the register), SURF-15 (subscription gate has a caller), SURF-16
// app half (audited team writes, audited member creation, reconciled gates).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { folderAclChain, type CollectionTree, type CollectionTreeRow } from "@/lib/serverCollections";
import { canServeContent, canDiscover } from "@/lib/permissions";
import { registerToCsv, type RegisterRow } from "@/lib/docControlRegister";
import type { AccessControl } from "@/types/schema";

const src = (p: string) => readFileSync(process.cwd() + "/" + p, "utf8");

function tree(rows: CollectionTreeRow[]): CollectionTree {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, CollectionTreeRow[]>();
  for (const r of rows) { const k = r.parent_id ?? null; const a = childrenOf.get(k); if (a) a.push(r); else childrenOf.set(k, [r]); }
  return { byId, childrenOf };
}
const acl = (tag: string): AccessControl => ({ rules: [{ id: tag, subject: { type: "user", id: tag }, effect: "allow", actions: ["read"] }] } as unknown as AccessControl);

describe("DOCACL-4 — a move re-indexes the subtree from the LIVE chain; folders are born chain-indexed", () => {
  it("folderAclChain walks the live parent_id tree root→leaf with the library ACL first", () => {
    const t = tree([
      { id: "root", parent_id: null, name: "root", acl: acl("root") },
      { id: "mid", parent_id: "root", name: "mid", acl: null },
      { id: "leaf", parent_id: "mid", name: "leaf", acl: acl("leaf") },
    ]);
    const chain = folderAclChain(t, acl("lib"), "leaf");
    expect(chain.map((c) => (c ? (c as unknown as { rules: Array<{ id: string }> }).rules[0].id : undefined))).toEqual(["lib", "root", undefined, "leaf"]);
    // After an in-memory re-parent the chain follows the NEW parent, not path_ids.
    t.byId.get("leaf")!.parent_id = null;
    expect(folderAclChain(t, acl("lib"), "leaf").length).toBe(2);
  });
  it("the move route rewrites acl_index for folders and documents after the path rebuild, and reports a failure instead of hiding it", () => {
    const r = src("app/api/collections/move/route.ts");
    expect(r.indexOf("rebuildSubtreePaths(supabaseAdmin, tree, [collectionId])")).toBeLessThan(r.indexOf("rebuildSubtreeAclIndex(supabaseAdmin, tree,"));
    expect(r).toMatch(/aclIndexRewritten: aclCounts/);
    expect(r).toMatch(/the nightly rebuild will repair them; until then the old inheritance is enforced/);
    const s = src("lib/serverCollections.ts");
    expect(s).toMatch(/from\("documents"\)\.select\("id, collection_id, acl"\)\.in\("collection_id"/);
    expect(s).toMatch(/buildAclIndexFromChain\(\[\.\.\.folderAclChain\(tree, libraryAcl, d\.collection_id\), d\.acl \?\? undefined\], nowMs\)/);
  });
  it("createFolder indexes library → ancestors → parent → self, expiry-aware", () => {
    const l = src("lib/libraryCollections.ts");
    expect(l).toMatch(/const aclIndex = await buildNewFolderIndex\(input\.libraryId, parentId, input\.acl\);/);
    const fn = l.slice(l.indexOf("async function buildNewFolderIndex"), l.indexOf("export async function createFolder"));
    expect(fn).toMatch(/from\("libraries"\)\.select\("acl"\)/);
    expect(fn).toMatch(/for \(const id of ancestorIds\) chain\.push\(byId\.get\(id\)\);/);
    expect(fn).toMatch(/chain\.push\(parent\?\.acl \?\? undefined\);\s*\n\s*\}\s*\n\s*chain\.push\(acl\);\s*\n\s*return buildAclIndexFromChain\(chain, now\);/);
  });
});

describe("DOCACL-5 — content is served on read/download, never on discover", () => {
  const principal = { uid: "u1", role: "Engineer-1" as const, roles: ["Engineer-1" as const], orgId: "o", teamIds: [], isActiveMember: true };
  const grant = (actions: string[]): AccessControl => ({ rules: [{ id: "r", subject: { type: "user", id: "u1" }, effect: "allow", actions }] } as unknown as AccessControl);
  it("a discover-only grantee of a private node can see it exists but is refused the bytes", () => {
    expect(canDiscover({ principal, aclChain: [grant(["discover"])], visibility: "private" })).toBe(true);
    expect(canServeContent({ principal, aclChain: [grant(["discover"])], visibility: "private" })).toBe(false);
  });
  it("read or download grants serve; owners and controllers short-circuit; normal nodes stay default-open", () => {
    expect(canServeContent({ principal, aclChain: [grant(["read"])], visibility: "hidden" })).toBe(true);
    expect(canServeContent({ principal, aclChain: [grant(["download"])], visibility: "private" })).toBe(true);
    expect(canServeContent({ principal, aclChain: [], visibility: "private", effectiveOwnerUserId: "u1" })).toBe(true);
    expect(canServeContent({ principal: { ...principal, role: "DocCtrl", roles: ["DocCtrl"] }, aclChain: [], visibility: "private" })).toBe(true);
    expect(canServeContent({ principal, aclChain: [], visibility: "normal" })).toBe(true);
  });
  it("the download-url route uses canServeContent", () => {
    const r = src("app/api/storage/download-url/route.ts");
    expect(r).toMatch(/const allowed = canServeContent\(\{/);
    expect(r).not.toMatch(/canDiscover\(/);
  });
});

describe("DEL-6 — the owner can open the recertification they are told to do", () => {
  it("the library page admits the library owner to the recert flow; the explorer matrix says so", () => {
    const p = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(p).toMatch(/const isLibraryOwner = !!uid && !!library\?\.ownerUserId && library\.ownerUserId === uid;/);
    expect(p).toMatch(/\{\(isController \|\| isLibraryOwner\) && \([\s\S]{0,2500}Access recertification/);
    const e = src("components/permissions/PermissionsExplorer.tsx");
    expect(e).toMatch(/cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner"/);
    expect(e).not.toMatch(/the owner path is a known gap/);
  });
});

describe("DEL-8 — the register shows the live owner, never the snapshot", () => {
  const base: RegisterRow = {
    id: "d", number: "P-1", title: "T", libraryId: "l", libraryName: "L", status: "Issued", rev: "A", updatedAt: null,
    ownerName: null, ownerUserId: null, owned: false, nextReviewDate: null, reviewStatus: "none", reviewDaysLeft: null,
    ack: null, ackStatus: "none",
  } as unknown as RegisterRow;
  it("an owned-but-unnamed row never prints as if it fell to the controllers; the Owner status column is explicit", () => {
    const csv = registerToCsv([{ ...base, ownerUserId: "u9", owned: true, ownerName: null }, base]);
    const [header, owned, unowned] = csv.split("\n");
    expect(header).toContain("Owner status");
    expect(owned).toContain("assigned member");
    expect(owned).toContain("active owner");
    expect(unowned).toContain("— (falls to Admin/DocCtrl)");
    expect(unowned).toContain("unowned — falls to Admin/DocCtrl");
  });
  it("the loader resolves the owner's current display name from active members", () => {
    const d = src("lib/docControlRegister.ts");
    expect(d).toMatch(/select\("uid, display_name, email"\)\.eq\("org_id", orgId\)\.eq\("status", "active"\)/);
    expect(d).toMatch(/ownerName: owner\.userId \? \(activeName\.get\(owner\.userId\) \?\? owner\.name \?\? "assigned member"\) : null,/);
  });
});

describe("SURF-15 — the subscription gate has a caller on the billable mutation", () => {
  it("create-user consults assertOrgHasAccess; refusal rides SUBSCRIPTION_ENFORCE, otherwise it is logged", () => {
    const r = src("app/api/admin/create-user/route.ts");
    expect(r).toMatch(/const gate = await assertOrgHasAccess\(supabaseAdmin, orgId\);/);
    expect(r).toMatch(/process\.env\.SUBSCRIPTION_ENFORCE === "true"/);
    expect(r).toMatch(/subscription gate would refuse org/);
    expect(src("lib/serverAuth.ts")).toMatch(/export async function assertOrgHasAccess/);
  });
});

describe("SURF-16 (app half) — team writes and member creation leave a trail", () => {
  it("createTeam / updateTeam / addTeamMember / removeTeamMember audit; update and remove are checked writes", () => {
    const t = src("lib/teams.ts");
    for (const a of ["TEAM_CREATED", "TEAM_UPDATED", "TEAM_MEMBER_ADDED", "TEAM_MEMBER_REMOVED"]) expect(t).toContain(`action: "${a}"`);
    expect(t).toMatch(/from\("teams"\)\.update\(row\)\.eq\("id", teamId\)\.select\("id"\)/);
    expect(t).toMatch(/\.delete\(\)\.eq\("team_id", teamId\)\.eq\("uid", uid\)\.select\("uid"\)/);
    const pg = src("app/(protected)/admin/teams/page.tsx");
    expect(pg).toMatch(/removeTeamMember\(selected\.id, memberUid, \{ orgId: activeOrgId, actorId: uid, actorEmail: userEmail \}\)/);
    expect(pg).toMatch(/addedByEmail: userEmail/);
  });
  it("the members page's gates read the collection and match the routes they front", () => {
    const u = src("app/(protected)/admin/users/page.tsx");
    expect(u).toMatch(/if \(!hasAnyRole\(\['Admin', 'Manager', 'DocCtrl'\]\)\)/);
    expect(u).toMatch(/const canAddMember = hasAnyRole\(\['Admin', 'DocCtrl'\]\);/);
    expect(u).toMatch(/const canManageMembership = hasAnyRole\(\['Admin', 'Manager'\]\);/);
    expect(u).toMatch(/const isAdmin = hasAnyRole\(\['Admin'\]\);/);
    expect(u).not.toMatch(/\['Admin', 'Manager'\]\.includes\(activeRole\)/);
    expect(u).toMatch(/canAddMember \? \(\s*<Button onClick=\{\(\) => setIsModalOpen\(true\)\}>/);
  });

  it("create-user writes MEMBER_CREATED after the membership insert", () => {
    const r = src("app/api/admin/create-user/route.ts");
    expect(r.indexOf('action: "MEMBER_CREATED"')).toBeGreaterThan(r.indexOf('.from("org_members")\n    .insert({'));
  });
});
