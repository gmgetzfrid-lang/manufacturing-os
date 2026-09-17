// Round E — OWN-20: descendant acl_index is recomputed when a library's (or a
// folder's) ACL changes — through the SAME rebuild the nightly cron runs,
// narrowed to one library subtree, diff-guarded, behind /api/acl/rebuild.
// The route takes the drawer's own save authority (controller / effective
// owner / managePermissions on the node's chain) — membership alone is not
// a licence to run service-role subtree rebuilds in a loop.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccessControl, AccessRule } from "@/types/schema";
import { buildAclIndexFromChain } from "@/lib/acl";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  updates: [] as Array<{ table: string; id: string; patch: Record<string, unknown> }>,
}));
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let pendingPatch: Record<string, unknown> | null = null;
  const rows = () => (state.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "update") pendingPatch = args[0] as Record<string, unknown>;
        if (prop === "eq") {
          if (pendingPatch && args[0] === "id") {
            const patch = pendingPatch; pendingPatch = null;
            state.updates.push({ table, id: String(args[1]), patch });
            return Promise.resolve({ error: null });
          }
          preds.push((r) => r[args[0] as string] === args[1]);
        }
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const fakeSb = { from: (t: string) => chain(t) } as unknown as SupabaseClient;

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async (orgId: string, uid: string) => {
    const m = (state.tables.org_members ?? []).find((r) => r.org_id === orgId && r.uid === uid && r.status === "active");
    if (!m) return null;
    const roles = [...new Set([m.role as string, ...((m.roles as string[]) ?? [])])];
    return { uid, orgId, role: m.role, roles, isController: roles.includes("Admin") || roles.includes("DocCtrl"),
      teamIds: (state.tables.team_members ?? []).filter((t) => t.uid === uid).map((t) => t.team_id as string) };
  }),
}));
vi.mock("@/lib/aclIndexRebuild", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/aclIndexRebuild")>();
  return { ...orig, rebuildAclIndexes: vi.fn(orig.rebuildAclIndexes) };
});
import { rebuildAclIndexes } from "@/lib/aclIndexRebuild";
import { POST as rebuildRoute } from "@/app/api/acl/rebuild/route";

const allow = (id: string, ...actions: string[]): AccessRule =>
  ({ effect: "allow", subject: { type: "role", id }, actions: actions as AccessRule["actions"] });
const NOW = Date.parse("2026-09-17T00:00:00Z");
const post = (body: unknown, token = "t") => rebuildRoute(new NextRequest("http://x/api/acl/rebuild", {
  method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => { state.user = null; state.tables = {}; state.calls = []; state.updates = []; vi.mocked(rebuildAclIndexes).mockClear(); });

/** Two libraries in one org; L1's ACL changed after its folder/doc were indexed. */
function seedStale() {
  const libAclNew: AccessControl = { rules: [allow("Viewer", "read")] };            // the NEW library rule
  const libAclOld: AccessControl = { rules: [allow("Drafter", "read")] };           // what descendants were indexed under
  const folderAcl: AccessControl = { rules: [allow("Engineer-1", "write")] };
  state.tables.libraries = [
    { id: "L1", org_id: "o1", acl: libAclNew, acl_index: buildAclIndexFromChain([libAclNew], NOW) },
    { id: "L2", org_id: "o1", acl: libAclOld, acl_index: buildAclIndexFromChain([libAclOld], NOW) },
  ];
  state.tables.collections = [
    { id: "F1", org_id: "o1", library_id: "L1", path_ids: [], acl: folderAcl, acl_index: buildAclIndexFromChain([libAclOld, folderAcl], NOW) }, // stale
    { id: "F2", org_id: "o1", library_id: "L2", path_ids: [], acl: null, acl_index: buildAclIndexFromChain([libAclOld, undefined], NOW) },      // fresh (L2 unchanged)
  ];
  state.tables.documents = [
    { id: "D1", org_id: "o1", library_id: "L1", collection_id: "F1", acl: null, acl_index: buildAclIndexFromChain([libAclOld, folderAcl, undefined], NOW) }, // stale
    { id: "D2", org_id: "o1", library_id: "L1", collection_id: null, acl: null, acl_index: buildAclIndexFromChain([libAclNew, undefined], NOW) },           // already fresh
    { id: "D3", org_id: "o1", library_id: "L2", collection_id: "F2", acl: null, acl_index: buildAclIndexFromChain([libAclOld, undefined, undefined], NOW) }, // fresh
  ];
  state.tables.document_sets = [];
  return { libAclNew, folderAcl };
}

describe("rebuildAclIndexes with a library scope", () => {
  it("reads only that library's subtree and rewrites only the nodes whose index is stale", async () => {
    const { libAclNew, folderAcl } = seedStale();
    const counts = await rebuildAclIndexes(fakeSb, NOW, { orgId: "o1", libraryId: "L1" });
    expect(counts.errors).toEqual([]);
    expect(counts.orgs).toBe(1);
    // no org listing, and every subtree read is scoped to L1
    expect(state.calls.some((c) => c.table === "orgs")).toBe(false);
    for (const t of ["collections", "documents", "document_sets"]) {
      expect(state.calls.some((c) => c.table === t && c.method === "eq" && c.args[0] === "library_id" && c.args[1] === "L1"), t).toBe(true);
    }
    expect(state.calls.some((c) => c.table === "libraries" && c.method === "eq" && c.args[0] === "id" && c.args[1] === "L1")).toBe(true);
    // diff guard: the stale folder + stale document are rewritten from the NEW chain; the fresh ones are not touched
    expect(state.updates.map((u) => `${u.table}:${u.id}`).sort()).toEqual(["collections:F1", "documents:D1"]);
    expect(state.updates.find((u) => u.id === "F1")!.patch.acl_index).toEqual(buildAclIndexFromChain([libAclNew, folderAcl], NOW));
    expect(state.updates.find((u) => u.id === "D1")!.patch.acl_index).toEqual(buildAclIndexFromChain([libAclNew, folderAcl, undefined], NOW));
    expect(counts.folders).toBe(1); expect(counts.documents).toBe(1); expect(counts.libraries).toBe(0);
  });
  it("is idempotent: a second scoped run writes nothing", async () => {
    seedStale();
    await rebuildAclIndexes(fakeSb, NOW, { orgId: "o1", libraryId: "L1" });
    // apply the writes to the fixture, then rerun
    for (const u of state.updates) { const row = (state.tables[u.table] ?? []).find((r) => r.id === u.id)!; row.acl_index = u.patch.acl_index; }
    state.updates = [];
    const again = await rebuildAclIndexes(fakeSb, NOW, { orgId: "o1", libraryId: "L1" });
    expect(state.updates).toEqual([]);
    expect(again.folders + again.documents + again.libraries + again.sets).toBe(0);
  });
  it("without a scope the walk still lists orgs and reads whole orgs (the cron path is unchanged)", async () => {
    seedStale();
    state.tables.orgs = [{ id: "o1" }];
    const counts = await rebuildAclIndexes(fakeSb, NOW);
    expect(state.calls.some((c) => c.table === "orgs")).toBe(true);
    expect(state.calls.some((c) => c.method === "eq" && c.args[0] === "library_id")).toBe(false);
    expect(counts.errors).toEqual([]);
    expect(state.updates.map((u) => `${u.table}:${u.id}`).sort()).toEqual(["collections:F1", "documents:D1"]);
  });
});

describe("POST /api/acl/rebuild", () => {
  const member = (uid: string, role = "Drafter", roles: string[] = [role]) => ({ org_id: "o1", uid, status: "active", role, roles });
  it("401 without a session; 403 for a non-member; 404 for a library outside the org", async () => {
    expect((await post({ orgId: "o1", libraryId: "L1" }, "")).status).toBe(401);
    state.user = { id: "u1" };
    state.tables.org_members = [];
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(403);
    state.tables.org_members = [member("u1", "Admin")];
    state.tables.libraries = [{ id: "L1", org_id: "other-org" }];
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(404);
    expect((await post({ orgId: "o1" })).status).toBe(400);
    expect(vi.mocked(rebuildAclIndexes)).not.toHaveBeenCalled();
  });
  it("403 for a plain active member: membership is not authority over the library (no rebuild runs)", async () => {
    seedStale();
    state.user = { id: "u1" };
    state.tables.org_members = [member("u1")];
    const res = await post({ orgId: "o1", libraryId: "L1" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/authority to change its permissions/);
    expect(vi.mocked(rebuildAclIndexes)).not.toHaveBeenCalled();
  });
  it("200: a controller (by the role COLLECTION) triggers the scoped rebuild and gets counts back (no rows)", async () => {
    seedStale();
    state.user = { id: "u1" };
    state.tables.org_members = [member("u1", "Manager", ["Manager", "DocCtrl"])];
    const res = await post({ orgId: "o1", libraryId: "L1" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(vi.mocked(rebuildAclIndexes)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rebuildAclIndexes).mock.calls[0][2]).toEqual({ orgId: "o1", libraryId: "L1" });
    expect(out).toEqual({ ok: true, rebuilt: { libraries: 0, folders: 1, documents: 1, sets: 0 }, errors: [] });
  });
  it("200: the library's owner, and the owning team's supervisor, hold the drawer's authority", async () => {
    seedStale();
    state.user = { id: "own" };
    state.tables.org_members = [member("own")];
    state.tables.libraries[0].owner_user_id = "own";
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(200);
    // team rung
    seedStale();
    state.tables.libraries[0].owner_team_id = "t1";
    state.tables.teams = [{ id: "t1", supervisor_user_id: "own" }];
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(200);
    state.tables.teams = [{ id: "t1", supervisor_user_id: "someone-else" }];
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(403);
  });
  it("200: a managePermissions grant on the library ACL; 403 when the grant is only read", async () => {
    seedStale();
    state.user = { id: "u1" };
    state.tables.org_members = [member("u1")];
    state.tables.libraries[0].acl = { rules: [allow("Drafter", "managePermissions")] };
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(200);
    state.tables.libraries[0].acl = { rules: [allow("Drafter", "read")] };
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(403);
  });
  it("a folder save: the folder's owner, or a manage grant on the folder's chain, is admitted with collectionId; a foreign folder is 404", async () => {
    seedStale();
    state.user = { id: "fo" };
    state.tables.org_members = [member("fo")];
    state.tables.collections[0].owner_user_id = "fo";
    expect((await post({ orgId: "o1", libraryId: "L1", collectionId: "F1" })).status).toBe(200);
    // the same member without collectionId is not the LIBRARY's owner
    expect((await post({ orgId: "o1", libraryId: "L1" })).status).toBe(403);
    // manage grant on the folder itself
    seedStale();
    state.tables.collections[0].acl = { rules: [allow("Drafter", "managePermissions")] };
    expect((await post({ orgId: "o1", libraryId: "L1", collectionId: "F1" })).status).toBe(200);
    // a folder that belongs to another library
    expect((await post({ orgId: "o1", libraryId: "L1", collectionId: "F2" })).status).toBe(404);
  });
});
