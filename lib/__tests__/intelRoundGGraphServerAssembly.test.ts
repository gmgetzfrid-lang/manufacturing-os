// intelligence Round G (I-15 GRAPH SERVER ASSEMBLY) — GAP-313, GM-14 limb 2,
// GAP-303's graph limb, GM-7's reader census.
//
// GET /api/graph assembles the org graph on the server for ONE caller: every
// read as the caller (runWithServerClient(callerScopedClient(req)) — their
// own RLS), plus the app's document predicate (loadPrincipal +
// readableControlledDocIds). Driven end to end over the in-memory PostgREST
// stand-in (helpers/graphFakeDb.ts): one database seen through two readers'
// RLS (a controller sees every row; a granted-nothing member does not see the
// restricted drawing, nor the links to it — DACL-11 / 20261126's rails).
//
//   * the PAYLOAD COMPARISON (DEC-90 ruling for I-15): the route's map for a
//     controller is the client assembly's map for that controller, deep-equal
//     — org-wide and scoped; for a granted-nothing member whose predicate
//     agrees with RLS, the client assembly's map for that member; where the
//     predicate is stricter than RLS (a document RLS lists and canReadNode
//     refuses), exactly that document and the links naming it are gone and
//     the access count says one more is outside their access;
//   * fails closed: a predicate that cannot decide answers 503 and no map; an
//     unreadable principal 503; a non-member 403; no session 401;
//   * never shared: each call is its caller's, `Cache-Control: private,
//     no-store`, and callers interleaved get their own maps;
//   * the pending proposal pairs ride in the payload; a pair naming a refused
//     document is dropped;
//   * GM-14 / GAP-303: the doc ↔ asset edge carries its sheet, pages and who
//     asserted it, an AI-read page marked, with the read falling back tier by
//     tier on a database before 20261171 / 20261170 (org-wide and scoped);
//     the theme draws a machine reading apart and labels it;
//   * fetchOrgGraph, the page's one request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Row } from "./helpers/graphFakeDb";

const st = vi.hoisted(() => ({
  users: {} as Record<string, string>,              // token → uid
  principals: {} as Record<string, unknown>,          // uid → principal (null: not a member)
  principalThrows: false,
  clients: {} as Record<string, unknown>,             // token → the caller's RLS-bound client
  predicate: null as null | ((ids: string[]) => Set<string>),
  predicateThrows: null as Error | null,
  predicateCalls: [] as string[][],
  proposals: { pairs: [] as unknown[], total: 0 as number | null, capped: false, error: null as string | null },
  // fix pass: the answer budget the route holds the body to (null: the real one).
  budget: null as number | null,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) => st.users[token]
        ? { data: { user: { id: st.users[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    from: () => { throw new Error("the service role reads nothing of the map"); },
  },
}));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: (req: Request) => {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return st.clients[token] ?? { error: "Missing access token", status: 401 };
  },
}));
vi.mock("@/lib/knowledgeAccess", async (orig) => {
  const actual = await orig<typeof import("@/lib/knowledgeAccess")>();
  return {
    ...actual,
    loadPrincipal: vi.fn(async (_orgId: string, uid: string) => {
      if (st.principalThrows) throw new actual.PrincipalUnreadableError("membership", "timeout");
      return (st.principals[uid] ?? null) as Awaited<ReturnType<typeof actual.loadPrincipal>>;
    }),
    readableControlledDocIds: vi.fn(async (p: { isController: boolean }, ids: string[]) => {
      st.predicateCalls.push([...ids]);
      if (st.predicateThrows) throw st.predicateThrows;
      if (p.isController) return new Set(ids);
      return st.predicate ? st.predicate(ids) : new Set(ids);
    }),
  };
});
vi.mock("@/lib/orgGraph", async (orig) => {
  const actual = await orig<typeof import("@/lib/orgGraph")>();
  return { ...actual, fitGraphPayload: (p: Parameters<typeof actual.fitGraphPayload>[0], b?: number) => actual.fitGraphPayload(p, st.budget ?? b) };
});
vi.mock("@/lib/linkProposals", async (orig) => ({
  ...(await orig<typeof import("@/lib/linkProposals")>()),
  readPendingProposalPairs: vi.fn(async () => structuredClone(st.proposals)),
}));

import { NextRequest } from "next/server";
import { GET as graphRoute } from "@/app/api/graph/route";
import { makeGraphFake, newGraphFakeDb, resetGraphFakeDb } from "./helpers/graphFakeDb";
import { runWithServerClient } from "@/lib/serverClientScope";
import {
  buildOrgGraph, fetchOrgGraph, GraphLoadError, relationOf, unpackGraphPayload, graphTooLargeMessage, PAIRS_LEFT_OUT, type OrgGraph,
} from "@/lib/orgGraph";
import { DcLandscapeUnreadableError, PRINCIPAL_UNREADABLE } from "@/lib/knowledgeAccess";
import { edgeRgbFor, edgeLabelFor, EDGE_RGB, EDGE_LEGEND, TAG_MACHINE_RGB, AI_READ_MARK } from "@/components/graph/graphTheme";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });
const doc = (id: string, over: Row = {}) => o({
  id, document_number: `DWG-${id}`, title: `Drawing ${id}`, library_id: "L1", unit_id: null, unit_code: "20",
  plant_id: null, system_id: null, sheet_number: null, sheet_total: null, updated_at: `2026-09-0${id.slice(-1)}`, ...over,
});

/** One plant. d2 is RESTRICTED (RLS hides it from the member, and the links
 *  naming it — DACL-11 / 20261126); d3 is a normal drawing RLS lists to the
 *  member, which the app's predicate may refuse (a denied role, DACL-12). */
function plant(): Record<string, Row[]> {
  return {
    codebook_entries: [o({ id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0, meta: {} })],
    plants: [o({ id: "p1", name: "Refinery", code: "BR", archived: false })],
    units: [o({ id: "u1", name: "Crude", code: "U100", plant_id: "p1", codebook_code: "20", archived: false })],
    systems: [],
    collections: [],
    libraries: [o({ id: "L1", name: "P&IDs" })],
    projects: [o({ id: "pr1", name: "Turnaround", status: "active" })],
    plot_plans: [],
    documents: [doc("d1"), doc("d2"), doc("d3"), doc("d4")],
    assets: [
      o({ id: "a1", tag: "P-101", description: "Charge pump", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
      o({ id: "a2", tag: "E-204", description: "Exchanger", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
    ],
    document_assets: [
      o({ id: "da1", document_id: "d1", asset_id: "a1", source: "drawing", sheet_label: "SHT 4", pages: [4, 4], asserted_by: "machine", model: "vision-x" }),
      o({ id: "da2", document_id: "d2", asset_id: "a1", source: "manual", sheet_label: null, pages: [], asserted_by: "human", model: null }),
      o({ id: "da3", document_id: "d3", asset_id: "a2", source: "jsonb_sync", sheet_label: null, pages: null, asserted_by: "human", model: null }),
      o({ id: "da4", document_id: "d4", asset_id: "a2", source: "drawing", sheet_label: null, pages: [2], asserted_by: "machine", model: null }),
    ],
    project_documents: [o({ id: "pd1", project_id: "pr1", document_id: "d3" })],
    document_related_resources: [
      o({ id: "r1", document_id: "d1", target_document_id: "d3", kind: "document" }),
      o({ id: "r2", document_id: "d1", target_document_id: "d2", kind: "document" }),
    ],
    document_supersessions: [o({ id: "s1", superseded_doc_id: "d3", replacement_doc_id: "d4" })],
    entity_mentions: [
      o({ id: "m1", asset_id: "a1", document_id: null, knowledge_document_id: "k3" }),
      o({ id: "m2", asset_id: "a2", document_id: "d1", knowledge_document_id: null }),
    ],
    process_flows: [o({ id: "f1", from_kind: "asset", from_ref: "a1", to_kind: "asset", to_ref: "a2", status: "confirmed" })],
    knowledge_documents: [o({ id: "k3", source_document_id: "d3" })],
    knowledge_libraries: [],
  };
}

const touchesD2 = (r: Row) => [r.document_id, r.target_document_id, r.superseded_doc_id, r.replacement_doc_id].includes("d2");
const ctrlDb = newGraphFakeDb();
const memberDb = newGraphFakeDb();
function seed(): void {
  for (const d of [ctrlDb, memberDb]) {
    resetGraphFakeDb(d, plant());
    d.rpc.documents_total_for_org = () => ({ data: 4, error: null });
  }
  memberDb.hidden = {
    documents: (r) => r.id === "d2",
    document_assets: touchesD2, document_related_resources: touchesD2,
    document_supersessions: touchesD2, project_documents: touchesD2,
  };
}
const ctrlClient = makeGraphFake(ctrlDb);
const memberClient = makeGraphFake(memberDb);

const CTRL = { uid: "u-ctrl", orgId: ORG, role: "DocCtrl", roles: ["DocCtrl"], isController: true, teamIds: [] };
const MEMBER = { uid: "u-mem", orgId: ORG, role: "Engineer", roles: ["Engineer"], isController: false, teamIds: [] };

beforeEach(() => {
  seed();
  st.users = { tc: "u-ctrl", tm: "u-mem", tx: "u-out" };
  st.principals = { "u-ctrl": CTRL, "u-mem": MEMBER };
  st.principalThrows = false;
  st.clients = { tc: ctrlClient, tm: memberClient, tx: memberClient };
  st.predicate = null;
  st.predicateThrows = null;
  st.predicateCalls = [];
  st.proposals = { pairs: [], total: 0, capped: false, error: null };
  st.budget = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const ask = (token: string | null, qs = `orgId=${ORG}`) => graphRoute(new NextRequest(`http://x/api/graph?${qs}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));
/** The client assembly, as the browser runs it: buildOrgGraph reading
 *  through the shared client, here bound to that reader's RLS view. */
const clientMap = (client: unknown, scope?: { kind: "unit"; code: string }) =>
  runWithServerClient(client, () => (scope ? buildOrgGraph(ORG, { scope }) : buildOrgGraph(ORG)));
/** The route's answer, unpacked as fetchOrgGraph unpacks it (a refusal,
 *  which carries no map, as sent). */
const read = (r: Response) => r.json().then((j) => (j.graph ? unpackGraphPayload(j) : j));
const ids = (g: OrgGraph) => g.nodes.map((n) => n.id).sort();
const edgesOf = (g: OrgGraph, id: string) => g.edges.filter((e) => e.a === id || e.b === id);

describe("GAP-313 — reproduction: the map was assembled in the browser, by the page", () => {
  it("on the base the page called buildOrgGraph itself and no /api/graph route existed; now the page loads one payload", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/graph/page.tsx"), "utf8");
    expect(page).not.toMatch(/\bbuildOrgGraph\(/);
    expect(page).not.toMatch(/readPendingProposalPairs\(/);
    expect(page).toMatch(/fetchOrgGraph\(activeOrgId, \{ scope \}\) : fetchOrgGraph\(activeOrgId\)/);
  });
});

describe("GAP-313 acceptance 1 — the payload comparison against the client assembly for the same org", () => {
  it("a CONTROLLER's payload is exactly the map the client assembly gives them (org-wide)", async () => {
    const res = await ask("tc");
    expect(res.status).toBe(200);
    const body = await read(res);
    const client = await clientMap(ctrlClient);
    expect(body.graph).toEqual(JSON.parse(JSON.stringify(client)));
    expect(ids(body.graph)).toContain("doc:d2");
  });

  it("a CONTROLLER's scoped payload is exactly the client assembly's scoped map", async () => {
    const res = await ask("tc", `orgId=${ORG}&scope=unit:20`);
    expect(res.status).toBe(200);
    const body = await read(res);
    const client = await clientMap(ctrlClient, { kind: "unit", code: "20" });
    expect(body.graph).toEqual(JSON.parse(JSON.stringify(client)));
    expect(body.graph.scope).toMatchObject({ label: "Crude Unit" });
  });

  it("a GRANTED-NOTHING member whose predicate agrees with RLS gets exactly the client assembly's map for them — the restricted drawing absent, as in their browser", async () => {
    st.predicate = (asked) => new Set(asked.filter((id) => id !== "d2"));
    const body = await read(await ask("tm"));
    const client = await clientMap(memberClient);
    expect(body.graph).toEqual(JSON.parse(JSON.stringify(client)));
    expect(ids(body.graph)).not.toContain("doc:d2");
    expect(body.graph.access).toMatchObject({ documentsVisible: 3, documentsTotal: 4, outsideAccess: 1 });
  });

  it("where the predicate is STRICTER than RLS (d3 listed, canReadNode refuses it): exactly d3 and the links naming it are gone, uncounted, and one more document is outside their access", async () => {
    st.predicate = (asked) => new Set(asked.filter((id) => id !== "d2" && id !== "d3"));
    const body = await read(await ask("tm"));
    const client = await clientMap(memberClient);
    const g = body.graph as OrgGraph;
    // the client assembly (RLS alone) shows d3 and its links …
    expect(ids(client)).toContain("doc:d3");
    expect(edgesOf(client, "doc:d3").length).toBeGreaterThan(0);
    // … the server map is the same map without them
    // (the project tied only to d3 is left with no link, and the assembly
    // prunes an empty grouping node, as it always has)
    expect(ids(g)).toEqual(ids(client).filter((id) => id !== "doc:d3" && id !== "proj:pr1"));
    expect(edgesOf(g, "doc:d3")).toEqual([]);
    expect(g.edges).toEqual(JSON.parse(JSON.stringify(client.edges.filter((e) => e.a !== "doc:d3" && e.b !== "doc:d3"))));
    // nothing about d3 leaks as "a link that leads off the map"
    expect(g.severed).toBe(client.severed);
    expect(g.access).toMatchObject({ documentsVisible: 2, documentsTotal: 4, outsideAccess: 2, documentsDrawn: 2 });
    expect(g.truncations).toContain("2 documents in this org are outside your access and not on this map — orphans, hubs and bridges are computed on what you can see.");
    // the predicate was asked once, about the documents the member's RLS listed
    expect(st.predicateCalls).toEqual([["d4", "d3", "d1"]]);
  });

  it("the same stricter predicate on a SCOPED map: d3 is not drawn, and the map says documents are outside the member's access", async () => {
    st.predicate = (asked) => new Set(asked.filter((id) => id !== "d3"));
    const body = await read(await ask("tm", `orgId=${ORG}&scope=unit:20`));
    const client = await clientMap(memberClient, { kind: "unit", code: "20" });
    expect(ids(client)).toContain("doc:d3");
    expect(ids(body.graph)).not.toContain("doc:d3");
    expect(edgesOf(body.graph, "doc:d3")).toEqual([]);
    expect(body.graph.truncations).toContain("1 document you could otherwise list is outside your access under the library, folder and document rules — not on this map.");
    expect(body.graph.access).toMatchObject({ scoped: true, documentsVisible: client.access!.documentsVisible! - 1 });
  });

  it("before 20261138 (no documents_total_for_org) a refused document is still said, never silently missing", async () => {
    memberDb.rpc = {};
    st.predicate = (asked) => new Set(asked.filter((id) => id !== "d3"));
    const body = await read(await ask("tm"));
    expect(body.graph.access.outsideAccess).toBeNull();
    expect(body.graph.truncations).toContain("1 document you could otherwise list is outside your access under the library, folder and document rules — not on this map.");
  });
});

describe("GAP-313 — fails closed, and never one payload across callers", () => {
  it("a predicate that cannot decide answers 503 with the sentence and NO map", async () => {
    st.predicateThrows = new DcLandscapeUnreadableError("libraries", "statement timeout");
    const res = await ask("tm");
    expect(res.status).toBe(503);
    const body = await read(res);
    expect(body.graph).toBeUndefined();
    expect(body.accessUnchecked).toBe(true);
    expect(body.error).toMatch(/document access couldn't be checked just now, so the map is not drawn/);
  });

  it("an unreadable principal is 503 PRINCIPAL_UNREADABLE; a non-member 403; no session 401; a bad scope 400", async () => {
    st.principalThrows = true;
    let res = await ask("tm");
    expect(res.status).toBe(503);
    expect((await read(res)).error).toBe(PRINCIPAL_UNREADABLE);
    st.principalThrows = false;
    res = await ask("tx");
    expect(res.status).toBe(403);
    res = await ask(null);
    expect(res.status).toBe(401);
    res = await ask("nope");
    expect(res.status).toBe(401);
    res = await ask("tc", `orgId=${ORG}&scope=plant:1`);
    expect(res.status).toBe(400);
    res = await ask("tc", "");
    expect(res.status).toBe(400);
  });

  it("a required read failing is the client assembly's own error (500, the same sentence) — never a smaller map", async () => {
    ctrlDb.readError = { documents: { message: "statement timeout" } };
    const res = await ask("tc");
    expect(res.status).toBe(500);
    await expect(clientMap(ctrlClient)).rejects.toThrow("statement timeout");
    expect((await read(res)).error).toBe("statement timeout");
  });

  it("each answer is private and uncached, and interleaved callers each get their own map", async () => {
    const m1 = await ask("tm");
    expect(m1.headers.get("cache-control")).toBe("private, no-store");
    const c1 = await read(await ask("tc"));
    const m2 = await read(await ask("tm"));
    expect(ids(c1.graph)).toContain("doc:d2");
    expect(ids((await read(m1)).graph)).not.toContain("doc:d2");
    expect(ids(m2.graph)).not.toContain("doc:d2");
    const fail = await ask("tm").then((r) => r.headers.get("cache-control"));
    expect(fail).toBe("private, no-store");
  });
});

describe("GAP-313 / GM-7 — the proposal pairs ride in the one payload", () => {
  const pair = (a: string, b: string) => ({ documentId: a, targetDocumentId: b, proposer: "tag", nodeA: `doc:${a}`, nodeB: `doc:${b}` });

  it("a controller gets the reader's queue as read; a pair naming a document the predicate refused is dropped for the member", async () => {
    st.proposals = { pairs: [pair("d1", "d3"), pair("d1", "d4")], total: 2, capped: false, error: null };
    const c = await read(await ask("tc"));
    expect(c.proposals).toEqual(st.proposals);
    st.predicate = (asked) => new Set(asked.filter((id) => id !== "d3"));
    const m = await read(await ask("tm"));
    expect(m.proposals.pairs).toEqual([pair("d1", "d4")]);
  });

  it("a failed proposal read is said in the payload, never a failed map (GM-7's three answers kept)", async () => {
    st.proposals = { pairs: [], total: null, capped: false, error: "statement timeout" };
    const res = await ask("tc");
    expect(res.status).toBe(200);
    expect((await read(res)).proposals).toEqual({ pairs: [], total: null, capped: false, error: "statement timeout" });
  });
});

describe("GM-14 limb 2 / GAP-303 graph limb — the doc ↔ asset edge carries its sheet and who asserted it", () => {
  it("a machine reading carries sheet, pages and the AI-read mark; a person's link without a sheet is the pair it always was, marked human", async () => {
    const g = await clientMap(ctrlClient);
    const tag = (d: string, a: string) => g.edges.find((e) => e.type === "tag" && e.a === `doc:${d}` && e.b === `asset:${a}`);
    expect(tag("d1", "a1")).toEqual({ a: "doc:d1", b: "asset:a1", type: "tag", sheet: "SHT 4", pages: [4], assertedBy: "machine", aiRead: true });
    expect(tag("d4", "a2")).toEqual({ a: "doc:d4", b: "asset:a2", type: "tag", pages: [2], assertedBy: "machine" });
    expect(tag("d3", "a2")).toEqual({ a: "doc:d3", b: "asset:a2", type: "tag", assertedBy: "human" });
  });

  it("before 20261171 (no asserted_by / model) a 'drawing' row is still a machine's reading, never AI-marked by guess", async () => {
    ctrlDb.missingColumns = { document_assets: ["asserted_by", "model"] };
    const g = await clientMap(ctrlClient);
    expect(g.edges.find((e) => e.a === "doc:d1" && e.type === "tag")).toEqual({ a: "doc:d1", b: "asset:a1", type: "tag", sheet: "SHT 4", pages: [4], assertedBy: "machine" });
    expect(g.edges.find((e) => e.a === "doc:d3" && e.type === "tag")).toEqual({ a: "doc:d3", b: "asset:a2", type: "tag" });
    expect(ctrlDb.calls.filter((c) => c.table === "document_assets" && c.method === "select").map((c) => c.args[0]))
      .toContain("id, document_id, asset_id, source, sheet_label, pages");
  });

  it("before 20261170 (no sheet_label / pages) the map draws exactly the pairs it drew before — org-wide and scoped", async () => {
    ctrlDb.missingColumns = { document_assets: ["sheet_label", "asserted_by"] };
    for (const g of [await clientMap(ctrlClient), await clientMap(ctrlClient, { kind: "unit", code: "20" })]) {
      const tags = g.edges.filter((e) => e.type === "tag");
      expect(tags.length).toBeGreaterThan(0);
      for (const e of tags) expect(Object.keys(e).sort()).toEqual(["a", "b", "type"]);
    }
  });

  it("the scoped read carries the same provenance", async () => {
    const g = await clientMap(ctrlClient, { kind: "unit", code: "20" });
    expect(g.edges.find((e) => e.a === "doc:d1" && e.type === "tag")).toMatchObject({ sheet: "SHT 4", assertedBy: "machine", aiRead: true });
  });

  it("relationOf says only what the row says", () => {
    expect(relationOf({ document_id: "d", asset_id: "a" })).toBeUndefined();
    expect(relationOf({ document_id: "d", asset_id: "a", source: "manual", sheet_label: "  ", pages: ["x", 0, 3] })).toEqual({ pages: [3] });
    expect(relationOf({ document_id: "d", asset_id: "a", asserted_by: "human", model: "vision-x" })).toEqual({ assertedBy: "human" });
  });

  it("the theme draws a machine reading apart from a person's link and labels it with its sheet and the AI-read mark", () => {
    expect(edgeRgbFor({ type: "tag", assertedBy: "machine" })).toBe(TAG_MACHINE_RGB);
    expect(TAG_MACHINE_RGB).not.toBe(EDGE_RGB.tag);
    expect(Object.values(EDGE_RGB)).not.toContain(TAG_MACHINE_RGB);
    expect(edgeRgbFor({ type: "tag", assertedBy: "human" })).toBe(EDGE_RGB.tag);
    expect(edgeRgbFor({ type: "tag" })).toBe(EDGE_RGB.tag);
    expect(edgeLabelFor({ type: "tag", assertedBy: "machine", sheet: "SHT 4", aiRead: true })).toBe(`Read from the drawing · SHT 4 (${AI_READ_MARK})`);
    expect(AI_READ_MARK).toBe("AI-read, unconfirmed");
    expect(edgeLabelFor({ type: "tag", assertedBy: "machine", pages: [2, 3] })).toBe("Read from the drawing · pages 2, 3");
    expect(edgeLabelFor({ type: "tag" })).toBe("Shared equipment");
    expect(EDGE_LEGEND.find((l) => l.key === "tag-machine")).toMatchObject({ rgb: TAG_MACHINE_RGB, arrow: false });
  });
});

describe("GAP-313 (fix pass) — the answer is held to the budget one buffered response can carry", () => {
  const pair = (a: string, b: string) => ({ documentId: a, targetDocumentId: b, proposer: "tag", nodeA: `doc:${a}`, nodeB: `doc:${b}` });

  it("the body is packed (edges by node position) and unpacks to exactly the map and pairs — JSON, private, uncached", async () => {
    st.proposals = { pairs: [pair("d1", "d3")], total: 1, capped: false, error: null };
    const res = await ask("tc");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const raw = await res.clone().json();
    expect(raw.graph.wire).toBe(1);
    expect(raw.graph.edges.every((e: unknown[]) => typeof e[0] === "number" && typeof e[1] === "number" && typeof e[2] === "number")).toBe(true);
    expect(raw.proposals.pairs).toEqual([["d1", "d3", "tag"]]);
    const body = await read(res);
    expect(body.graph).toEqual(JSON.parse(JSON.stringify(await clientMap(ctrlClient))));
    expect(body.proposals).toEqual(st.proposals);
  });

  it("past the budget the proposal pairs are left out and the payload says why; the map still arrives", async () => {
    st.proposals = { pairs: Array.from({ length: 200 }, () => pair("d1", "d3")), total: 200, capped: false, error: null };
    const full = (await (await ask("tc")).text()).length;
    st.budget = full - 10;
    const res = await ask("tc");
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.graph).toEqual(JSON.parse(JSON.stringify(await clientMap(ctrlClient))));
    expect(body.proposals).toEqual({ pairs: [], total: 200, capped: false, error: PAIRS_LEFT_OUT });
  });

  it("a map past the budget even alone is refused with the reason (413, tooLarge) — never sent for the platform to cut", async () => {
    st.budget = 100;
    const res = await ask("tc");
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.graph).toBeUndefined();
    expect(body.tooLarge).toBe(true);
    expect(body.error).toMatch(/^This map is too large to send in one answer \(0\.0 MB\), so it is not drawn\. Scope the map to one unit/);
  });
});

describe("GAP-313 — fetchOrgGraph, the page's one request", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks GET /api/graph once, with the scope, and hands back the map and the proposals", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ graph: { nodes: [], edges: [], truncations: [] }, proposals: { pairs: [], total: 0, capped: false, error: null } }) };
    }));
    const r = await fetchOrgGraph(ORG, { scope: { kind: "unit", code: "20" } });
    expect(calls).toEqual([`/api/graph?orgId=${ORG}&scope=unit%3A20`]);
    expect(r.graph.nodes).toEqual([]);
    expect(r.proposals.total).toBe(0);
  });

  it("a refusal is a GraphLoadError carrying the route's sentence, and whether access was unchecked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "no map", accessUnchecked: true }) })));
    const e = await fetchOrgGraph(ORG).catch((x) => x);
    expect(e).toBeInstanceOf(GraphLoadError);
    expect(e).toMatchObject({ message: "no map", status: 503, accessUnchecked: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } })));
    await expect(fetchOrgGraph(ORG)).rejects.toMatchObject({ message: "The map could not be loaded (HTTP 502).", accessUnchecked: false, tooLarge: false });
  });

  it("a packed answer is unpacked to the map and the pairs it carried", async () => {
    st.proposals = { pairs: [{ documentId: "d1", targetDocumentId: "d4", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d4" }], total: 1, capped: false, error: null };
    const sent = await (await ask("tc")).text();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse(sent) })));
    const r = await fetchOrgGraph(ORG);
    expect(r.graph).toEqual(JSON.parse(JSON.stringify(await clientMap(ctrlClient))));
    expect(r.proposals).toEqual(st.proposals);
  });

  it("a map too large to send is a GraphLoadError marked tooLarge — the route's 413 with its sentence, or the platform's bare 413", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 413, json: async () => ({ error: "This map is too large to send in one answer (4.2 MB), so it is not drawn.", tooLarge: true }) })));
    await expect(fetchOrgGraph(ORG)).rejects.toMatchObject({ status: 413, tooLarge: true, message: "This map is too large to send in one answer (4.2 MB), so it is not drawn." });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 413, json: async () => { throw new Error("FUNCTION_PAYLOAD_TOO_LARGE"); } })));
    await expect(fetchOrgGraph(ORG)).rejects.toMatchObject({ status: 413, tooLarge: true, message: graphTooLargeMessage(null) });
  });
});

describe("GM-7 residual — the reader is unchanged; 20261233 indexes its order", () => {
  it("the keyset read still orders created_at desc then id desc, the new index's columns in order", () => {
    const reader = readFileSync(join(process.cwd(), "lib/linkProposals.ts"), "utf8");
    expect(reader).toMatch(/\.order\("created_at", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\)/);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261233_intel_roundG_proposed_links_keyset_index.sql"), "utf8");
    expect(sql).toMatch(/ON proposed_links \(org_id, status, created_at DESC, id DESC\)/);
  });
});
