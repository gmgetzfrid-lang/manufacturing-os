// intelligence Round G I-32 PROVENANCE VIEW AND WIZARD ADOPT — GAP-303
// acceptance 1 / GAP-316 (the one per-asset "how we came to believe this"
// view), GOV-9 criterion 4's graph label limb and GAP-303's graph remainder
// (the graph's edges agree with the provenance view). DEC-90 rulings (1), (2)
// and (4).
//
//   * lib/relationProvenance.ts — the one reading of a relation row both the
//     graph and the view use;
//   * the agreement matrix: for every kind of relation row, the provenance
//     view's standing and sheet mark and the graph edge's colour and label say
//     the same thing;
//   * the org graph (buildOrgGraph over the filter-aware PostgREST stand-in):
//     a machine reading a person also tagged is drawn as theirs too; a
//     person's link carrying the sweep's sheet address marks it unconfirmed;
//     a failed tags read leaves the edges as before and says so; nothing else
//     on the map changes (regression pin);
//   * GET /api/assets/provenance — every relation with its asserter, read as
//     the caller; a relation on a document the reader may not read (RLS, or
//     the I-12 predicate) is not shown and not counted, nor its decisions or
//     the discovery's source; a failed read is said, never "none"; the
//     predicate that cannot decide fails closed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Row } from "./helpers/graphFakeDb";

const st = vi.hoisted(() => ({
  users: {} as Record<string, string>,
  principals: {} as Record<string, unknown>,
  principalThrows: false,
  clients: {} as Record<string, unknown>,
  predicate: null as null | ((ids: string[]) => Set<string>),
  predicateThrows: null as Error | null,
  predicateCalls: [] as string[][],
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) => st.users[token]
        ? { data: { user: { id: st.users[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    from: () => { throw new Error("the service role reads nothing of the story"); },
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

import { NextRequest } from "next/server";
import { GET as provenanceRoute } from "@/app/api/assets/provenance/route";
import { makeGraphFake, newGraphFakeDb, resetGraphFakeDb } from "./helpers/graphFakeDb";
import { runWithServerClient } from "@/lib/serverClientScope";
import { buildOrgGraph, relationOf, type GraphEdge } from "@/lib/orgGraph";
import { edgeRgbFor, edgeLabelFor, EDGE_RGB, TAG_MACHINE_RGB, AI_READ_MARK as THEME_AI_MARK } from "@/components/graph/graphTheme";
import {
  AI_READ_MARK, SWEEP_SHEET_MARK, assetTagsName, linkStandingOf, relationAsserter, sheetMarkOf, sheetReadingOf,
} from "@/lib/relationProvenance";
import {
  assembleAssetProvenance, PROVENANCE_ACCESS_UNCHECKED, PROVENANCE_DECISION_CAP, PROVENANCE_DECISION_PAGE, PROVENANCE_LINK_CAP,
  type AssetProvenance, type ProvRelationRow,
} from "@/lib/assetProvenance";
import { PRINCIPAL_UNREADABLE } from "@/lib/knowledgeAccess";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });

// ─── lib/relationProvenance.ts ──────────────────────────────────────────────

describe("lib/relationProvenance — the one reading of a relation row", () => {
  it("who asserted it: asserted_by when the row says; before 20261171 a 'drawing' row is a machine's and any other source a person's", () => {
    expect(relationAsserter({ asserted_by: "machine", source: "manual" })).toBe("machine");
    expect(relationAsserter({ asserted_by: "human", source: "drawing" })).toBe("human");
    expect(relationAsserter({ source: "drawing" })).toBe("machine");
    expect(relationAsserter({ source: "manual" })).toBe("human");
    expect(relationAsserter({ source: "jsonb_sync" })).toBe("human");
    expect(relationAsserter({})).toBeNull();
  });

  it("where the sheet address came from: AI transcription, a machine's text-layer reading, or the sweep's address on a person's link", () => {
    expect(sheetReadingOf({ sheet_label: "SHT 4", asserted_by: "machine", model: "vision-x" })).toBe("ai");
    expect(sheetReadingOf({ sheet_label: "SHT 4", asserted_by: "machine", model: null })).toBe("text");
    expect(sheetReadingOf({ sheet_label: "SHT 4", source: "drawing" })).toBe("text");
    expect(sheetReadingOf({ sheet_label: "SHT 4", source: "manual", asserted_by: "human" })).toBe("sweep");
    expect(sheetReadingOf({ sheet_label: "SHT 4", source: "jsonb_sync" })).toBe("sweep");
    expect(sheetReadingOf({ sheet_label: "  ", asserted_by: "machine", model: "vision-x" })).toBeNull();
    expect(sheetReadingOf({ asserted_by: "human" })).toBeNull();
    expect(sheetMarkOf("ai")).toBe(AI_READ_MARK);
    expect(sheetMarkOf("sweep")).toBe(SWEEP_SHEET_MARK);
    expect(sheetMarkOf("text")).toBeNull();
    expect(sheetMarkOf(null)).toBeNull();
    expect(AI_READ_MARK).toBe("AI-read, unconfirmed");
    expect(THEME_AI_MARK).toBe(AI_READ_MARK);
  });

  it("a person also tagged it: the document's own equipment tags name the tag in the one grammar; a machine reading then stands as theirs too", () => {
    const keys = new Set(["p101"]);
    expect(assetTagsName([{ tag: "P 101" }], keys)).toBe(true);
    expect(assetTagsName([{ tag: "P-102" }, null, { nope: 1 }], keys)).toBe(false);
    expect(assetTagsName(null, keys)).toBe(false);
    expect(linkStandingOf({ asserted_by: "machine" }, true)).toBe("machine_person_also");
    expect(linkStandingOf({ asserted_by: "machine" }, false)).toBe("machine");
    expect(linkStandingOf({ source: "manual" }, true)).toBe("person");
  });
});

// ─── The agreement matrix: the provenance view and the graph's edge ────────

const ASSET = { id: "a1", tag: "P-101", origin: "manual" as const, discovered_from: null };
const KINDS: Array<{ name: string; row: ProvRelationRow; docTags: unknown }> = [
  { name: "machine, text layer", row: { asserted_by: "machine", source: "drawing", sheet_label: "SHT 4", model: null }, docTags: [] },
  { name: "machine, AI transcription", row: { asserted_by: "machine", source: "drawing", sheet_label: "SHT 4", model: "vision-x", source_revision: "B" }, docTags: [] },
  { name: "machine, a person also tagged", row: { asserted_by: "machine", source: "drawing", sheet_label: "SHT 4", model: "vision-x" }, docTags: [{ tag: "P101" }] },
  { name: "a person's link adopted from the sweep (sheet kept, model cleared)", row: { asserted_by: "human", source: "manual", sheet_label: "SHT 4", model: null, asserted_by_user: "u-ann" }, docTags: [] },
  { name: "a person's link, no sheet", row: { asserted_by: "human", source: "manual", asserted_by_user: "u-ann" }, docTags: [] },
  { name: "the document's own tags", row: { asserted_by: "human", source: "jsonb_sync" }, docTags: [{ tag: "P-101" }] },
  { name: "before 20261171, a drawing row", row: { source: "drawing", sheet_label: "SHT 4" }, docTags: [] },
];

describe("GAP-303 graph remainder — the provenance view and the graph's edges agree, row by row", () => {
  for (const k of KINDS) {
    it(k.name, () => {
      const story = assembleAssetProvenance({
        asset: ASSET,
        documentRelations: [{ ...k.row, id: "r1", document_id: "d1" }],
        knowledgeRelations: [],
        readableDocuments: new Map([["d1", { id: "d1", document_number: "PID-1", library_id: "L1", asset_tags: k.docTags }]]),
        readableKnowledge: new Map(),
        audits: [], names: new Map([["u-ann", "Ann"]]), notes: [], knowledgeRelationInstalled: true,
      });
      const link = story.links[0];
      const personTagged = assetTagsName(k.docTags, new Set(["p101"]));
      const edge: GraphEdge = { a: "doc:d1", b: "asset:a1", type: "tag", ...relationOf({ ...k.row, document_id: "d1", asset_id: "a1" }, personTagged) };
      // machine-read vs person-asserted
      const drawnAsMachine = edgeRgbFor(edge) === TAG_MACHINE_RGB;
      expect(drawnAsMachine).toBe(link.standing === "machine");
      expect(edgeRgbFor(edge) === EDGE_RGB.tag).toBe(link.standing !== "machine");
      expect(/read from the drawing/i.test(edgeLabelFor(edge))).toBe(link.standing !== "person");
      expect(/^Tagged, and read from the drawing/.test(edgeLabelFor(edge))).toBe(link.standing === "machine_person_also");
      // the same sheet mark, in the same words
      if (link.sheetMark) expect(edgeLabelFor(edge)).toContain(`(${link.sheetMark})`);
      else expect(edgeLabelFor(edge)).not.toMatch(/unconfirmed/);
    });
  }

  it("the view words each asserter: a machine's reading with its model and revision; a person's link with who linked it; a tag-sync row never names the last editor", () => {
    const story = assembleAssetProvenance({
      asset: ASSET,
      documentRelations: KINDS.map((k, i) => ({ ...k.row, id: `r${i}`, document_id: `d${i}`, created_at: `2026-10-0${i + 1}T00:00:00Z` })),
      knowledgeRelations: [],
      readableDocuments: new Map(KINDS.map((k, i) => [`d${i}`, { id: `d${i}`, document_number: `PID-${i}`, library_id: "L1", asset_tags: k.docTags }])),
      readableKnowledge: new Map(),
      audits: [], names: new Map([["u-ann", "Ann"]]), notes: [], knowledgeRelationInstalled: true,
    });
    const words = story.links.map((l) => l.assertedBy);
    expect(words[0]).toBe("The equipment sweep read it off the drawing — read from drawing (the PDF's own text); not typed by a person");
    expect(words[1]).toBe("The equipment sweep read it off the drawing — AI-read (vision-x); not typed by a person");
    expect(story.links[1]).toMatchObject({ model: "vision-x", revision: "B", sheet: "SHT 4", sheetMark: AI_READ_MARK });
    expect(words[2]).toMatch(/AI-read \(vision-x\); a person also tagged the document with it/);
    expect(words[3]).toBe("Linked by Ann");
    expect(story.links[3]).toMatchObject({ sheetMark: SWEEP_SHEET_MARK, model: null });
    expect(words[4]).toBe("Linked by Ann");
    expect(words[5]).toBe("A person tagged the document with it (its equipment tags)");
    expect(story.links[5].personName).toBeNull();
    // no adoption record handed in: the adopted link's date is when the pair was first recorded, said so
    expect(story.links.map((l) => l.atMeaning)).toEqual(["asserted", "asserted", "asserted", "first_recorded", "asserted", "asserted", "asserted"]);
  });

  it("an adopted link takes its date from the newest EQUIPMENT_BRIDGE_RELATION_ADOPTED naming this asset on that document — not another asset's, not another document's", () => {
    const adopted = KINDS[3].row;
    const story = assembleAssetProvenance({
      asset: ASSET,
      documentRelations: [{ ...adopted, id: "r3", document_id: "d3", created_at: "2026-03-01T00:00:00Z" }],
      knowledgeRelations: [],
      readableDocuments: new Map([["d3", { id: "d3", document_number: "PID-3", library_id: "L1", asset_tags: [] }]]),
      readableKnowledge: new Map(),
      audits: [
        { id: "x1", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: "d3", user_id: "u-ann", details: { assetId: "a1" }, created_at: "2026-10-01T00:00:00Z" },
        { id: "x2", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: "d3", user_id: "u-ann", details: { assetId: "a1" }, created_at: "2026-06-01T00:00:00Z" },
        { id: "x3", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: "d3", user_id: "u-ann", details: { assetId: "a-other", tag: "P-101" }, created_at: "2026-12-01T00:00:00Z" },
        { id: "x4", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: "d9", user_id: "u-ann", details: { assetId: "a1" }, created_at: "2026-12-02T00:00:00Z" },
      ],
      names: new Map([["u-ann", "Ann"]]), notes: [], knowledgeRelationInstalled: true,
    });
    expect(story.links[0]).toMatchObject({ assertedBy: "Linked by Ann", at: "2026-10-01T00:00:00Z", atMeaning: "asserted" });
  });
});

// ─── The org graph (GOV-9 criterion 4's graph label limb; GAP-303's remainder) ─

function plant(): Record<string, Row[]> {
  const doc = (id: string, over: Row = {}) => o({
    id, document_number: `DWG-${id}`, title: `Drawing ${id}`, library_id: "L1", unit_id: null, unit_code: "20",
    plant_id: null, system_id: null, sheet_number: null, sheet_total: null, updated_at: `2026-09-0${id.slice(-1)}`, ...over,
  });
  return {
    codebook_entries: [o({ id: "cb20", kind: "unit", code: "20", label: "Crude Unit", sort: 0, meta: {} })],
    plants: [o({ id: "p1", name: "Refinery", code: "BR", archived: false })],
    units: [o({ id: "u1", name: "Crude", code: "U100", plant_id: "p1", codebook_code: "20", archived: false })],
    systems: [], collections: [],
    libraries: [o({ id: "L1", name: "P&IDs" })],
    projects: [], plot_plans: [],
    documents: [doc("d1"), doc("d2", { asset_tags: [{ tag: "P 101" }] }), doc("d3"), doc("d4")],
    assets: [
      o({ id: "a1", tag: "P-101", description: "Charge pump", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
      o({ id: "a2", tag: "E-204", description: "Exchanger", unit_code: "20", unit_id: null, plant_id: null, system_id: null, type_id: null, library_id: null, archived: false }),
    ],
    document_assets: [
      // the sweep's AI reading, nobody tagged d1 with it
      o({ id: "da1", document_id: "d1", asset_id: "a1", source: "drawing", sheet_label: "SHT 4", pages: [4], asserted_by: "machine", model: "vision-x" }),
      // the sweep's reading on d2, whose own equipment tags name P-101
      o({ id: "da2", document_id: "d2", asset_id: "a1", source: "drawing", sheet_label: "SHT 2", pages: [2], asserted_by: "machine", model: "vision-x" }),
      // a person adopted the sweep's pair on d3 (sheet kept, model cleared)
      o({ id: "da3", document_id: "d3", asset_id: "a2", source: "manual", sheet_label: "SHT 7", pages: [7], asserted_by: "human", model: null }),
      // a person's plain link
      o({ id: "da4", document_id: "d4", asset_id: "a2", source: "manual", sheet_label: null, pages: null, asserted_by: "human", model: null }),
    ],
    project_documents: [], document_related_resources: [], document_supersessions: [],
    entity_mentions: [], process_flows: [], knowledge_documents: [], knowledge_libraries: [],
  };
}

const gdb = newGraphFakeDb();
const gclient = makeGraphFake(gdb);
const map = (scope?: { kind: "unit"; code: string }) =>
  runWithServerClient(gclient, () => (scope ? buildOrgGraph(ORG, { scope }) : buildOrgGraph(ORG)));
const tagEdge = (edges: GraphEdge[], d: string) => edges.find((e) => e.type === "tag" && e.a === `doc:${d}`);

describe("GOV-9 criterion 4 (graph label limb) and GAP-303's graph remainder — the org graph", () => {
  beforeEach(() => { resetGraphFakeDb(gdb, plant()); gdb.rpc.documents_total_for_org = () => ({ data: 4, error: null }); });

  it("REGRESSION: a machine reading nobody tagged is the edge it was (orange, 'Read from the drawing · SHT 4 (AI-read, unconfirmed)'); a person's plain link is the pair it was", async () => {
    const g = await map();
    expect(tagEdge(g.edges, "d1")).toEqual({ a: "doc:d1", b: "asset:a1", type: "tag", sheet: "SHT 4", pages: [4], assertedBy: "machine", aiRead: true });
    expect(edgeRgbFor(tagEdge(g.edges, "d1")!)).toBe(TAG_MACHINE_RGB);
    expect(edgeLabelFor(tagEdge(g.edges, "d1")!)).toBe(`Read from the drawing · SHT 4 (${AI_READ_MARK})`);
    expect(tagEdge(g.edges, "d4")).toEqual({ a: "doc:d4", b: "asset:a2", type: "tag", assertedBy: "human" });
    expect(edgeLabelFor(tagEdge(g.edges, "d4")!)).toBe("Shared equipment");
  });

  it("a machine reading whose document's own equipment tags name the tag is drawn as a person's too — slate, 'Tagged, and read from the drawing', the AI-read mark kept on its sheet", async () => {
    const g = await map();
    const e = tagEdge(g.edges, "d2")!;
    expect(e).toMatchObject({ assertedBy: "machine", personAlso: true, aiRead: true, sheet: "SHT 2" });
    expect(edgeRgbFor(e)).toBe(EDGE_RGB.tag);
    expect(edgeLabelFor(e)).toBe(`Tagged, and read from the drawing · SHT 2 (${AI_READ_MARK})`);
    // only the documents a machine reading links are asked for their tags
    const at = gdb.calls.findIndex((c) => c.table === "documents" && c.method === "select" && c.args[0] === "id, asset_tags");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(gdb.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "id, asset_tags")).toHaveLength(1);
    const inCall = gdb.calls.slice(at).find((c) => c.table === "documents" && c.method === "in");
    expect(inCall?.args).toEqual(["id", ["d1", "d2"]]);
  });

  it("a person's link carrying the sweep's sheet address shows it unconfirmed — never as a plain fact", async () => {
    const g = await map();
    const e = tagEdge(g.edges, "d3")!;
    expect(e).toEqual({ a: "doc:d3", b: "asset:a2", type: "tag", sheet: "SHT 7", pages: [7], assertedBy: "human", sheetUnconfirmed: true });
    expect(edgeRgbFor(e)).toBe(EDGE_RGB.tag);
    expect(edgeLabelFor(e)).toBe(`Shared equipment · SHT 7 (${SWEEP_SHEET_MARK})`);
  });

  it("the scoped read carries the same marks", async () => {
    const g = await map({ kind: "unit", code: "20" });
    expect(tagEdge(g.edges, "d2")).toMatchObject({ personAlso: true });
    expect(tagEdge(g.edges, "d3")).toMatchObject({ sheetUnconfirmed: true });
  });

  it("a tags read that fails marks nothing — the edges stay the sweep's alone, as before — and the map says so", async () => {
    // A client whose ONE tags read fails (statement timeout); every other read as before.
    const failed: Record<string, unknown> = new Proxy({}, {
      get: (_t, p: string) => (p === "then"
        ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "statement timeout" } })
        : () => failed),
    });
    let asked = 0;
    const client = {
      ...gclient,
      from: (t: string) => {
        const b = gclient.from(t) as Record<string, unknown>;
        if (t !== "documents") return b;
        return new Proxy(b, {
          get: (target, prop: string) => (prop === "select"
            ? (cols: string, ...rest: unknown[]) => {
                if (cols === "id, asset_tags") { asked += 1; return failed; }
                return (target.select as (...a: unknown[]) => unknown)(cols, ...rest);
              }
            : target[prop]),
        });
      },
    };
    const g = await runWithServerClient(client, () => buildOrgGraph(ORG));
    expect(asked).toBeGreaterThan(0);
    expect(tagEdge(g.edges, "d2")).toEqual({ a: "doc:d2", b: "asset:a1", type: "tag", sheet: "SHT 2", pages: [2], assertedBy: "machine", aiRead: true });
    expect(g.truncations.join(" ")).toMatch(/Which equipment-sweep readings a person also tagged could not be read \(statement timeout\)/);
  });
});

// ─── GET /api/assets/provenance ─────────────────────────────────────────────

function hubDb(): Record<string, Row[]> {
  return {
    assets: [o({ id: "a1", tag: "P-101", origin: "drawing", created_at: "2026-09-01T00:00:00Z", created_by: "u-ann",
      discovered_from: { documentId: "dR", pages: [3], door: "drawing", sheets: [{ page: 3, label: "PID-R SHT 3", aiRead: true }], auto: false } })],
    documents: [
      o({ id: "d1", document_number: "PID-1", title: "Charge", status: "Issued", library_id: "L1", asset_tags: [] }),
      o({ id: "d2", document_number: "DS-1", title: "Datasheet", status: "Issued", library_id: "L1", asset_tags: [{ tag: "P-101" }] }),
      o({ id: "d3", document_number: "PID-3", title: "Adopted", status: "Issued", library_id: "L1", asset_tags: [] }),
      o({ id: "dR", document_number: "PID-SECRET", title: "Restricted", status: "Issued", library_id: "L9", asset_tags: [] }),
      o({ id: "dP", document_number: "PID-DENIED", title: "Predicate-denied", status: "Issued", library_id: "L1", asset_tags: [] }),
    ],
    document_assets: [
      o({ id: "r1", document_id: "d1", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: "PID-1 SHT 4", pages: [4], asserted_by: "machine", asserted_by_user: null, model: "vision-x", source_revision: "B", vanished_at: null, superseded_at: null, created_at: "2026-09-02T00:00:00Z" }),
      o({ id: "r2", document_id: "d2", asset_id: "a1", tag_text: "P-101", source: "jsonb_sync", sheet_label: null, pages: null, asserted_by: "human", asserted_by_user: "u-last-editor", model: null, source_revision: null, vanished_at: null, superseded_at: null, created_at: "2026-09-03T00:00:00Z" }),
      o({ id: "r3", document_id: "d3", asset_id: "a1", tag_text: "P-101", source: "manual", sheet_label: "PID-3 SHT 1", pages: [1], asserted_by: "human", asserted_by_user: "u-ann", model: null, source_revision: null, vanished_at: null, superseded_at: null, created_at: "2026-09-04T00:00:00Z" }),
      o({ id: "rR", document_id: "dR", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: "PID-R SHT 3", pages: [3], asserted_by: "machine", asserted_by_user: null, model: "vision-x", source_revision: "A", vanished_at: null, superseded_at: null, created_at: "2026-09-01T00:00:00Z" }),
      o({ id: "rP", document_id: "dP", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: "PID-P SHT 9", pages: [9], asserted_by: "machine", asserted_by_user: null, model: null, source_revision: "C", vanished_at: null, superseded_at: null, created_at: "2026-09-05T00:00:00Z" }),
    ],
    knowledge_document_assets: [
      o({ id: "k1", knowledge_document_id: "kU", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: "UP-1 SHT 2", pages: [2], asserted_by: "machine", model: null, source_revision: null, created_at: "2026-09-06T00:00:00Z" }),
      o({ id: "k2", knowledge_document_id: "kM", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: "MIRROR", pages: [1], asserted_by: "machine", model: null, source_revision: null, created_at: "2026-09-07T00:00:00Z" }),
    ],
    knowledge_documents: [
      o({ id: "kU", name: "upload.pdf", library_id: "KL1", source_document_id: null }),
      o({ id: "kM", name: "mirror-of-denied.pdf", library_id: "KL1", source_document_id: "dP" }),
    ],
    audit_logs: [
      o({ id: "au1", action: "EQUIPMENT_BRIDGE_APPLIED", resource_type: "document", resource_id: "d1", user_id: "u-ann", details: { tags: ["P-101"], revision: "B" }, created_at: "2026-09-02T00:00:01Z" }),
      o({ id: "au2", action: "EQUIPMENT_BRIDGE_RELATION_ADOPTED", resource_type: "document", resource_id: "d3", user_id: "u-ann", details: { assetId: "a1", tag: "P-101", sheet: "PID-3 SHT 1", model: "vision-x", revision: "A" }, created_at: "2026-09-04T00:00:01Z" }),
      o({ id: "au3", action: "EQUIPMENT_BRIDGE_DISMISSED", resource_type: "document", resource_id: "dR", user_id: "u-ann", details: { tags: ["P-101"] }, created_at: "2026-09-08T00:00:00Z" }),
      o({ id: "au4", action: "EQUIPMENT_BRIDGE_DISMISSED", resource_type: "document", resource_id: "d1", user_id: "u-ann", details: { tags: ["E-204"] }, created_at: "2026-09-09T00:00:00Z" }),
      o({ id: "au5", action: "DOCUMENT_ISSUED", resource_type: "document", resource_id: "d1", user_id: "u-ann", details: { tags: ["P-101"] }, created_at: "2026-09-09T00:00:00Z" }),
    ],
    org_members: [
      o({ uid: "u-ann", display_name: "Ann Operator", email: "ann@x" }),
      o({ uid: "u-last-editor", display_name: "Last Editor", email: "le@x" }),
    ],
  };
}

const ctrlDb = newGraphFakeDb();
const memberDb = newGraphFakeDb();
const ctrlClient = makeGraphFake(ctrlDb);
const memberClient = makeGraphFake(memberDb);
const CTRL = { uid: "u-ctrl", orgId: ORG, role: "DocCtrl", roles: ["DocCtrl"], isController: true, teamIds: [] };
const MEMBER = { uid: "u-mem", orgId: ORG, role: "Engineer", roles: ["Engineer"], isController: false, teamIds: [] };

const ask = (token: string | null, qs = `orgId=${ORG}&assetId=a1`) => provenanceRoute(new NextRequest(`http://x/api/assets/provenance?${qs}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));
const story = async (token: string): Promise<AssetProvenance> => {
  const res = await ask(token);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return res.json();
};

describe("GAP-303 acceptance 1 / GAP-316 — GET /api/assets/provenance", () => {
  beforeEach(() => {
    resetGraphFakeDb(ctrlDb, hubDb());
    resetGraphFakeDb(memberDb, hubDb());
    // The member's RLS: dR (a restricted library) and the links naming it are not theirs (DACL-11).
    memberDb.hidden = { documents: (r) => r.id === "dR", document_assets: (r) => r.document_id === "dR" };
    st.users = { tc: "u-ctrl", tm: "u-mem", tx: "u-out" };
    st.principals = { "u-ctrl": CTRL, "u-mem": MEMBER };
    st.principalThrows = false;
    st.clients = { tc: ctrlClient, tm: memberClient, tx: memberClient };
    // The member's I-12 predicate is stricter than RLS on dP.
    st.predicate = (ids) => new Set(ids.filter((id) => id !== "dP" && id !== "dR"));
    st.predicateThrows = null;
    st.predicateCalls = [];
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("lists every relation — controlled documents and knowledge uploads — with who or what asserted it, in order; every read as the caller", async () => {
    const s = await story("tc");
    expect(s.asset).toEqual({ id: "a1", tag: "P-101" });
    expect(s.links.map((l) => l.target.label)).toEqual(["PID-SECRET", "PID-1", "DS-1", "PID-3", "PID-DENIED", "upload.pdf", "mirror-of-denied.pdf"]);
    const by = Object.fromEntries(s.links.map((l) => [l.target.label, l]));
    expect(by["PID-1"]).toMatchObject({ standing: "machine", model: "vision-x", revision: "B", sheet: "PID-1 SHT 4", sheetMark: AI_READ_MARK, pages: [4] });
    expect(by["PID-1"].assertedBy).toMatch(/AI-read \(vision-x\)/);
    expect(by["DS-1"]).toMatchObject({ standing: "person", personName: null, assertedBy: "A person tagged the document with it (its equipment tags)" });
    expect(by["PID-3"]).toMatchObject({ standing: "person", personName: "Ann Operator", assertedBy: "Linked by Ann Operator", sheetMark: SWEEP_SHEET_MARK });
    expect(by["upload.pdf"]).toMatchObject({ standing: "machine", target: { kind: "knowledge", href: "/knowledge/KL1?doc=kU" }, sheet: "UP-1 SHT 2" });
    expect(by["upload.pdf"].assertedBy).toMatch(/off the knowledge upload — read from drawing/);
    expect(s.notes).toEqual([]);
    expect(s.linksIncomplete).toBe(false);
    expect(s.decisionsUnread).toBe(false);
    expect(s.knowledgeRelationInstalled).toBe(true);
    // decisions: only the sweep's, only those naming this equipment
    expect(s.decisions.map((d) => d.action)).toEqual(["EQUIPMENT_BRIDGE_APPLIED", "EQUIPMENT_BRIDGE_RELATION_ADOPTED", "EQUIPMENT_BRIDGE_DISMISSED"]);
    expect(s.decisions[1]).toMatchObject({ actor: "Ann Operator", detail: "PID-3 SHT 1 — read off an AI transcription (vision-x), Rev A" });
    expect(s.discovery).toMatchObject({ kind: "sweep", door: "drawing", source: { label: "PID-SECRET" }, sourceHidden: false, confirmedByPerson: false });
    // GAP-316 'who': the registry's accountable identity (assets.created_by, BR-8), named through the caller's own members read
    expect(s.discovery).toMatchObject({ recordedBy: "Ann Operator" });
    expect(ctrlDb.calls.filter((c) => c.table === "assets" && c.method === "select").map((c) => c.args[0])[0])
      .toBe("id, tag, origin, discovered_from, created_at, created_by");
  });

  it("a relation on a document the reader may not read — hidden by RLS, or refused by the I-12 predicate — is not shown and not counted; nor its decisions; nor the discovery's source; nor an upload mirroring a refused document", async () => {
    const s = await story("tm");
    const labels = s.links.map((l) => l.target.label);
    expect(labels).toEqual(["PID-1", "DS-1", "PID-3", "upload.pdf"]);
    expect(JSON.stringify(s)).not.toMatch(/PID-SECRET|PID-DENIED|PID-R SHT 3|PID-P SHT 9|mirror-of-denied|MIRROR/);
    expect(s.decisions.map((d) => d.target.label)).toEqual(["PID-1", "PID-3"]);
    expect(s.discovery).toMatchObject({ kind: "sweep", source: null, sourceHidden: true, pages: [], sheets: [], revision: null });
    // the predicate was asked about every controlled document the RLS read listed, a mirror's source included
    expect(st.predicateCalls.flat()).toEqual(expect.arrayContaining(["d1", "d2", "d3", "dP"]));
    expect(st.predicateCalls.flat()).not.toContain("dR");
  });

  it("a failed read is SAID — never presented as 'none'", async () => {
    ctrlDb.readError.document_assets = { message: "statement timeout" };
    ctrlDb.readError.audit_logs = { message: "audit unreachable" };
    const s = await story("tc");
    expect(s.notes.join(" ")).toMatch(/links to controlled documents could not be read \(statement timeout\) — none of them is shown, which is not the same as none/);
    expect(s.notes.join(" ")).toMatch(/recorded decisions could not be read \(audit unreachable\)/);
    expect(s.links.every((l) => l.target.kind === "knowledge")).toBe(true);
    // DEC-90 ruling (1): each emptied section carries its own read state, so the view never says "none" for it
    expect(s.linksIncomplete).toBe(true);
    expect(s.decisionsUnread).toBe(true);
    expect(s.decisions).toEqual([]);
  });

  it("a failed audit read alone marks the decisions unread and leaves the links' state as read", async () => {
    ctrlDb.readError.audit_logs = { message: "audit unreachable" };
    const s = await story("tc");
    expect(s.decisionsUnread).toBe(true);
    expect(s.linksIncomplete).toBe(false);
    expect(s.links.length).toBeGreaterThan(0);
  });

  it("a failed knowledge-relation read marks the links incomplete, not the decisions", async () => {
    ctrlDb.readError.knowledge_document_assets = { message: "kda down" };
    const s = await story("tc");
    expect(s.linksIncomplete).toBe(true);
    expect(s.decisionsUnread).toBe(false);
    expect(s.notes.join(" ")).toMatch(/links to knowledge-library uploads could not be read \(kda down\)/);
  });

  it("a documents read that fails drops the links on them and says so (fail closed)", async () => {
    ctrlDb.readError.documents = { message: "documents down" };
    const s = await story("tc");
    expect(s.links.filter((l) => l.target.kind === "document")).toEqual([]);
    expect(s.notes.join(" ")).toMatch(/The linked documents could not be read \(documents down\)/);
    expect(s.linksIncomplete).toBe(true);
    expect(s.decisionsUnread).toBe(true);
  });

  it("before 20261235 (no knowledge_document_assets) the uploads' links are said to be unrecorded; before 20261171 / 20261170 the columns are dropped one step at a time", async () => {
    ctrlDb.missingTables.add("knowledge_document_assets");
    ctrlDb.missingColumns.document_assets = ["asserted_by", "sheet_label"];
    const s = await story("tc");
    expect(s.knowledgeRelationInstalled).toBe(false);
    expect(s.notes).toEqual([]);
    const pid1 = s.links.find((l) => l.target.label === "PID-1")!;
    expect(pid1).toMatchObject({ standing: "machine", model: null, sheet: null });
    expect(pid1.assertedBy).toMatch(/read from drawing \(the PDF's own text\)/);
    expect(ctrlDb.calls.filter((c) => c.table === "document_assets" && c.method === "select").map((c) => c.args[0]))
      .toEqual([
        "id, document_id, tag_text, source, sheet_label, pages, asserted_by, asserted_by_user, model, source_revision, vanished_at, superseded_at, created_at",
        "id, document_id, tag_text, source, sheet_label, pages, created_at",
        "id, document_id, tag_text, source, created_at",
      ]);
  });

  it("the predicate that cannot decide fails closed (503, no story); an unreadable principal 503; a non-member 403; no session 401; no ids 400", async () => {
    st.predicateThrows = new Error("landscape unreadable");
    const r1 = await ask("tm");
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toBe(PROVENANCE_ACCESS_UNCHECKED);
    st.predicateThrows = null;
    st.principalThrows = true;
    const r2 = await ask("tm");
    expect(r2.status).toBe(503);
    expect((await r2.json()).error).toBe(PRINCIPAL_UNREADABLE);
    st.principalThrows = false;
    expect((await ask("tx")).status).toBe(403);
    expect((await ask(null)).status).toBe(401);
    expect((await ask("tc", `orgId=${ORG}`)).status).toBe(400);
    expect((await ask("tc", `orgId=${ORG}&assetId=nope`)).status).toBe(404);
  });

  it("an asset whose origin is 'manual' reads 'person' with the registry's recorded creator named; one with nothing recorded says so (still naming the recorded creator)", async () => {
    ctrlDb.tables.assets = [o({ id: "a1", tag: "P-101", origin: "manual", discovered_from: null, created_by: "u-ann" })];
    expect((await story("tc")).discovery).toEqual({ kind: "person", recordedBy: "Ann Operator" });
    ctrlDb.missingColumns.assets = ["origin"];
    expect((await story("tc")).discovery).toEqual({ kind: "not_recorded", recordedBy: "Ann Operator" });
  });

  it("BR-8's placeholder identity (the nil uuid) is never named, nor looked up; an unreadable name is not invented", async () => {
    ctrlDb.tables.assets = [o({ id: "a1", tag: "P-101", origin: "manual", discovered_from: null, created_by: "00000000-0000-0000-0000-000000000000" })];
    expect((await story("tc")).discovery).toEqual({ kind: "person", recordedBy: null });
    const inArgs = ctrlDb.calls.filter((c) => c.table === "org_members" && c.method === "in").flatMap((c) => c.args[1] as string[]);
    expect(inArgs).not.toContain("00000000-0000-0000-0000-000000000000");
    ctrlDb.tables.assets = [o({ id: "a1", tag: "P-101", origin: "manual", discovered_from: null, created_by: "u-unknown" })];
    expect((await story("tc")).discovery).toEqual({ kind: "person", recordedBy: null });
  });
  // ── Second review fix pass: a read cut short is not a complete read (DEC-90 ruling (1)).

  const otherDecisions = (n: number) => Array.from({ length: n }, (_, i) => o({
    id: `ox${String(i).padStart(5, "0")}`, action: "EQUIPMENT_BRIDGE_APPLIED", resource_type: "document", resource_id: "d1",
    user_id: "u-ann", details: { tags: ["E-204"] }, created_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
  }));

  it("the decision read pages back past one page: this asset's older decisions are found behind a busy workspace's newer ones — and nothing is said to be cut short", async () => {
    ctrlDb.tables.audit_logs = [...ctrlDb.tables.audit_logs, ...otherDecisions(PROVENANCE_DECISION_PAGE + 500)];
    const s = await story("tc");
    expect(s.decisions.map((d) => d.action)).toEqual(["EQUIPMENT_BRIDGE_APPLIED", "EQUIPMENT_BRIDGE_RELATION_ADOPTED", "EQUIPMENT_BRIDGE_DISMISSED"]);
    expect(s.decisionsCapped).toBe(false);
    expect(s.decisionsUnread).toBe(false);
    expect(s.notes).toEqual([]);
  });

  it("the API's own row ceiling hands back short pages: the read keeps paging until a page comes back empty, never taking a short page for the end", async () => {
    ctrlDb.maxRows = 300;
    ctrlDb.tables.audit_logs = [...ctrlDb.tables.audit_logs, ...otherDecisions(700)];
    const s = await story("tc");
    expect(s.decisions.map((d) => d.action)).toEqual(["EQUIPMENT_BRIDGE_APPLIED", "EQUIPMENT_BRIDGE_RELATION_ADOPTED", "EQUIPMENT_BRIDGE_DISMISSED"]);
    expect(s.decisionsCapped).toBe(false);
  });

  it("past PROVENANCE_DECISION_CAP the older decisions were NOT searched: decisionsCapped, said in the notes, the asset's older decisions not presented as absent", async () => {
    ctrlDb.tables.audit_logs = [...ctrlDb.tables.audit_logs, ...otherDecisions(PROVENANCE_DECISION_CAP)];
    const s = await story("tc");
    expect(s.decisions).toEqual([]);
    expect(s.decisionsCapped).toBe(true);
    expect(s.decisionsUnread).toBe(false);
    expect(s.notes.join(" ")).toMatch(new RegExp(`latest ${PROVENANCE_DECISION_CAP} equipment-sweep decisions were searched — older ones about this equipment were not searched`));
    // it stopped at the cap: no page past it was asked for
    const ranges = ctrlDb.calls.filter((c) => c.table === "audit_logs" && c.method === "range").map((c) => c.args[0]);
    expect(Math.max(...(ranges as number[]))).toBeLessThan(PROVENANCE_DECISION_CAP);
  });

  it("a later page that fails marks the decisions unread and says how far the read got", async () => {
    ctrlDb.tables.audit_logs = [...ctrlDb.tables.audit_logs, ...otherDecisions(PROVENANCE_DECISION_PAGE)];
    let pages = 0;
    const base = ctrlClient.from.bind(ctrlClient);
    const failingSecond = {
      ...ctrlClient,
      from: (t: string) => {
        const b = base(t) as Record<string, unknown>;
        if (t !== "audit_logs") return b;
        pages += 1;
        if (pages === 1) return b;
        const failed: Record<string, unknown> = new Proxy({}, {
          get: (_t, p: string) => (p === "then"
            ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "page timeout" } })
            : () => failed),
        });
        return failed;
      },
    };
    st.clients.tc = failingSecond;
    const s = await story("tc");
    expect(s.decisionsUnread).toBe(true);
    expect(s.notes.join(" ")).toMatch(new RegExp(`Only the latest ${PROVENANCE_DECISION_PAGE} of the equipment sweep's recorded decisions could be read \\(page timeout\\)`));
  });

  it("a relation read that reaches PROVENANCE_LINK_CAP sets linksCapped (no exact count) and says there may be more", async () => {
    const extra = Array.from({ length: PROVENANCE_LINK_CAP }, (_, i) => o({
      id: `rx${i}`, document_id: "d1", asset_id: "a1", tag_text: "P-101", source: "drawing", sheet_label: null, pages: null,
      asserted_by: "machine", asserted_by_user: null, model: null, source_revision: null, vanished_at: null, superseded_at: null, created_at: "2026-08-01T00:00:00Z",
    }));
    ctrlDb.tables.document_assets = [...ctrlDb.tables.document_assets, ...extra];
    const s = await story("tc");
    expect(s.linksCapped).toBe(true);
    expect(s.linksIncomplete).toBe(false);
    expect(s.notes.join(" ")).toMatch(new RegExp(`Only the first ${PROVENANCE_LINK_CAP} links to controlled documents were read — there may be more`));
    expect((await story("tc")).decisionsCapped).toBe(false);
  });

  it("a documents read that fails leaves the discovery's source UNREAD — never 'not one you can open'", async () => {
    ctrlDb.readError.documents = { message: "documents down" };
    const s = await story("tc");
    expect(s.discovery).toMatchObject({ kind: "sweep", door: "drawing", source: null, sourceUnread: true, sourceHidden: false });
    // the reader's own access, read and refused, is still an access verdict
    const m = await story("tm");
    expect(m.discovery).toMatchObject({ kind: "sweep", source: null, sourceUnread: false, sourceHidden: true });
  });

  it("GAP-303 acceptance 1 'when': an adopted link's date is the adoption's record, not the sweep's created_at; with the adoption unread it is said to be when the pair was first recorded", async () => {
    const adopt = ctrlDb.tables.audit_logs.find((a) => a.id === "au2")!;
    adopt.created_at = "2026-10-01T00:00:00Z";
    const s = await story("tc");
    const pid3 = s.links.find((l) => l.target.label === "PID-3")!;
    expect(pid3).toMatchObject({ at: "2026-10-01T00:00:00Z", atMeaning: "asserted", assertedBy: "Linked by Ann Operator" });
    // a machine's reading keeps its own date, as asserted
    expect(s.links.find((l) => l.target.label === "PID-1")).toMatchObject({ at: "2026-09-02T00:00:00Z", atMeaning: "asserted" });
    ctrlDb.readError.audit_logs = { message: "audit unreachable" };
    const u = await story("tc");
    expect(u.links.find((l) => l.target.label === "PID-3")).toMatchObject({ at: "2026-09-04T00:00:00Z", atMeaning: "first_recorded" });
  });
});
