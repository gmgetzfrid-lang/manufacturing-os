// intelligence Round G (I-15 GRAPH SERVER ASSEMBLY), fix pass — DEC-90
// ruling (1), the payload comparison with the REAL predicate.
//
// intelRoundGGraphServerAssembly.test.ts stubs readableControlledDocIds, so
// it proves the route's wiring, not that a real member who holds no grant is
// filtered by the real rule. Here nothing of the predicate is stood in:
// GET /api/graph runs lib/knowledgeAccess loadPrincipal +
// readableControlledDocIds (lib/permissions canReadNode) over an in-memory
// service-role database holding the access landscape — libraries, folders,
// teams, memberships and the documents' own ACL rows — while the map is read
// as the caller (their RLS view, the same stand-in database).
//
//   L1  open library                           d1
//   L2  restricted: legacy read list ["HR"]    d2   (DACL-10's binding list)
//   L3  granted to team T-ops only             d3
//
// A member who holds no grant (Engineer, no team) reads d1 only; a member of
// T-ops reads d1 and d3; one who also holds HR in their role collection reads
// all three. Where RLS lists everything (DACL-12, before I-30 binds read
// denies in the database) the route's payload is the client assembly's map
// with exactly the refused documents, and every link naming them, gone; where
// RLS agrees with the predicate it is the client assembly's map, deep-equal.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Row } from "./helpers/graphFakeDb";

const st = vi.hoisted(() => ({
  users: {} as Record<string, string>,
  clients: {} as Record<string, unknown>,
  admin: null as null | { from: (t: string) => unknown },
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) => st.users[token]
        ? { data: { user: { id: st.users[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (t: string) => st.admin!.from(t),
  },
}));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: (req: Request) => {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return st.clients[token] ?? { error: "Missing access token", status: 401 };
  },
}));

import { NextRequest } from "next/server";
import { GET as graphRoute } from "@/app/api/graph/route";
import { makeGraphFake, newGraphFakeDb, resetGraphFakeDb } from "./helpers/graphFakeDb";
import { runWithServerClient } from "@/lib/serverClientScope";
import { buildOrgGraph, unpackGraphPayload, type OrgGraph } from "@/lib/orgGraph";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });
const allow = (type: string, id: string, actions: string[]) => ({ effect: "allow", subject: { type, id }, actions });
const doc = (id: string, library: string) => o({
  id, document_number: `DWG-${id}`, title: `Drawing ${id}`, library_id: library, collection_id: null,
  unit_id: null, unit_code: "20", plant_id: null, system_id: null, sheet_number: null, sheet_total: null,
  updated_at: `2026-09-0${id.slice(-1)}`,
  acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-author", owner_user_id: null,
});

function tables(): Record<string, Row[]> {
  return {
    // the landscape and the memberships (read by the service role only)
    org_members: [
      o({ uid: "u-ctrl", role: "DocCtrl", roles: ["DocCtrl"], status: "active" }),
      o({ uid: "u-none", role: "Engineer", roles: ["Engineer"], status: "active" }),
      o({ uid: "u-team", role: "Engineer", roles: ["Engineer"], status: "active" }),
      o({ uid: "u-hr", role: "Engineer", roles: ["Engineer", "HR"], status: "active" }),
    ],
    team_members: [{ uid: "u-team", team_id: "T-ops" }],
    teams: [o({ id: "T-ops", supervisor_user_id: null })],
    collections: [],
    libraries: [
      o({ id: "L1", name: "Open", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }),
      o({ id: "L2", name: "HR only", acl: { inherit: true, visibility: "normal", rules: [] }, visibility: "normal", read_access: ["HR"], visible_to: [], owner_user_id: null, owner_team_id: null }),
      o({ id: "L3", name: "Operations team", acl: { inherit: true, visibility: "normal", rules: [allow("team", "T-ops", ["discover", "read"])] }, visibility: "normal", owner_user_id: null, owner_team_id: null }),
    ],
    // the map
    codebook_entries: [o({ id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0, meta: {} })],
    plants: [], units: [], systems: [], plot_plans: [],
    projects: [o({ id: "pr1", name: "Turnaround", status: "active" })],
    documents: [doc("d1", "L1"), doc("d2", "L2"), doc("d3", "L3")],
    assets: [
      o({ id: "a1", tag: "P-101", description: "Charge pump", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
      o({ id: "a2", tag: "E-204", description: "Exchanger", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
    ],
    document_assets: [
      o({ id: "da1", document_id: "d1", asset_id: "a1", source: "manual", sheet_label: null, pages: null, asserted_by: "human", model: null }),
      o({ id: "da2", document_id: "d2", asset_id: "a1", source: "drawing", sheet_label: "SHT 2", pages: [2], asserted_by: "machine", model: null }),
      o({ id: "da3", document_id: "d3", asset_id: "a2", source: "manual", sheet_label: null, pages: null, asserted_by: "human", model: null }),
    ],
    project_documents: [o({ id: "pd1", project_id: "pr1", document_id: "d2" })],
    document_related_resources: [o({ id: "r1", document_id: "d1", target_document_id: "d2", kind: "document" })],
    document_supersessions: [o({ id: "s1", superseded_doc_id: "d2", replacement_doc_id: "d3" })],
    entity_mentions: [], process_flows: [], knowledge_documents: [], knowledge_libraries: [],
  };
}

const adminDb = newGraphFakeDb();
const listsAllDb = newGraphFakeDb();     // RLS lists every document (DACL-12)
const agreesDb = newGraphFakeDb();       // RLS hides what the predicate refuses
const names = (r: Row, refusedIds: string[]) =>
  [r.document_id, r.target_document_id, r.superseded_doc_id, r.replacement_doc_id].some((id) => refusedIds.includes(String(id)));
function seed(agreeRefuses: string[]): void {
  resetGraphFakeDb(adminDb, tables());
  for (const d of [listsAllDb, agreesDb]) {
    resetGraphFakeDb(d, tables());
    d.rpc.documents_total_for_org = () => ({ data: 3, error: null });
  }
  const hide = (r: Row) => names(r, agreeRefuses);
  agreesDb.hidden = {
    documents: (r) => agreeRefuses.includes(String(r.id)),
    document_assets: hide, document_related_resources: hide, document_supersessions: hide, project_documents: hide,
  };
}

beforeEach(() => {
  seed([]);
  st.admin = makeGraphFake(adminDb);
  st.users = { tc: "u-ctrl", tn: "u-none", tt: "u-team", th: "u-hr" };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const ask = async (token: string, client: unknown): Promise<{ status: number; graph: OrgGraph }> => {
  st.clients = { [token]: client };
  const res = await graphRoute(new NextRequest(`http://x/api/graph?orgId=${ORG}`, { headers: { authorization: `Bearer ${token}` } }));
  const body = await res.json();
  return { status: res.status, graph: body.graph ? unpackGraphPayload(body).graph : body };
};
const clientMap = (client: unknown) => runWithServerClient(client, () => buildOrgGraph(ORG));
const ids = (g: OrgGraph) => g.nodes.map((n) => n.id).sort();
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const touches = (e: { a: string; b: string }, gone: string[]) => gone.some((id) => e.a === id || e.b === id);

describe("DEC-90 ruling (1) — the payload comparison with the real predicate (no stub)", () => {
  it("the real predicate over this landscape: no grant reads d1; T-ops adds d3; HR in the role collection adds d2", async () => {
    const read = async (uid: string) => [...await readableControlledDocIds((await loadPrincipal(ORG, uid))!, ["d1", "d2", "d3"])].sort();
    expect(await read("u-none")).toEqual(["d1"]);
    expect(await read("u-team")).toEqual(["d1", "d3"]);
    expect(await read("u-hr")).toEqual(["d1", "d2"]);
    expect(await read("u-ctrl")).toEqual(["d1", "d2", "d3"]);
  });

  it("a GRANTED-NOTHING member where RLS lists everything: the client assembly's map with exactly d2, d3 and every link naming them gone, and the access line counts them", async () => {
    const client = makeGraphFake(listsAllDb);
    const { status, graph } = await ask("tn", client);
    expect(status).toBe(200);
    const theirs = await clientMap(client);
    const gone = ["doc:d2", "doc:d3"];
    expect(ids(theirs)).toEqual(expect.arrayContaining(gone));
    // pr1 was tied only to d2: an empty grouping node, pruned as always
    expect(ids(graph)).toEqual(ids(theirs).filter((id) => !gone.includes(id) && id !== "proj:pr1"));
    expect(graph.edges).toEqual(json(theirs.edges.filter((e) => !touches(e, gone))));
    expect(graph.severed).toBe(theirs.severed);
    expect(graph.access).toMatchObject({ documentsVisible: 1, documentsTotal: 3, outsideAccess: 2, documentsDrawn: 1 });
    // the landscape was read by the service role, the map was not
    expect(new Set(adminDb.calls.filter((c) => c.method === "select").map((c) => c.table)))
      .toEqual(new Set(["org_members", "team_members", "libraries", "collections", "teams", "documents"]));
    expect(adminDb.calls.some((c) => c.table === "document_assets" || c.table === "assets")).toBe(false);
  });

  it("the same member where RLS agrees with the predicate: the payload IS the client assembly's map, deep-equal", async () => {
    seed(["d2", "d3"]);
    st.admin = makeGraphFake(adminDb);
    const client = makeGraphFake(agreesDb);
    const { graph } = await ask("tn", client);
    expect(graph).toEqual(json(await clientMap(client)));
    expect(ids(graph)).not.toContain("doc:d2");
  });

  it("the principal keeps its TEAMS: a member of T-ops keeps d3 and loses only d2 (a principal built without teams would lose d3 too)", async () => {
    const client = makeGraphFake(listsAllDb);
    const { graph } = await ask("tt", client);
    const theirs = await clientMap(client);
    expect(ids(graph)).toContain("doc:d3");
    expect(ids(graph)).toEqual(ids(theirs).filter((id) => id !== "doc:d2" && id !== "proj:pr1"));
    expect(graph.edges).toEqual(json(theirs.edges.filter((e) => !touches(e, ["doc:d2"]))));
  });

  it("the principal keeps its ROLE COLLECTION: HR held beside the headline Engineer keeps d2 (its drawing reading too) and loses only d3", async () => {
    const client = makeGraphFake(listsAllDb);
    const { graph } = await ask("th", client);
    const theirs = await clientMap(client);
    expect(ids(graph)).toEqual(ids(theirs).filter((id) => id !== "doc:d3"));
    expect(graph.edges.find((e) => e.a === "doc:d2" && e.type === "tag")).toMatchObject({ sheet: "SHT 2", assertedBy: "machine" });
  });

  it("a controller is never refused: the payload is the client assembly's map, and no document row is read for the predicate", async () => {
    const client = makeGraphFake(listsAllDb);
    const { graph } = await ask("tc", client);
    expect(graph).toEqual(json(await clientMap(client)));
    expect(adminDb.calls.some((c) => c.table === "documents" || c.table === "libraries")).toBe(false);
  });

  it("the landscape unreadable for a member fails closed with the real error path: 503, no map", async () => {
    adminDb.readError = { libraries: { message: "statement timeout" } };
    const res = await ask("tn", makeGraphFake(listsAllDb));
    expect(res.status).toBe(503);
    expect((res.graph as unknown as { accessUnchecked?: boolean }).accessUnchecked).toBe(true);
  });
});
