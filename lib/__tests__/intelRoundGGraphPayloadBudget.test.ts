// intelligence Round G (I-15 GRAPH SERVER ASSEMBLY), fix pass — GAP-313: the
// size of the one answer.
//
// GET /api/graph sends the whole map and up to PENDING_PAIRS_CAP proposal
// pairs as ONE buffered response, and the hosting platform refuses a
// buffered function response past ~4.5 MB (vercel.json; the same limit
// lib/__tests__/transmittalPortalRoute.test.ts plans around). The review
// measured the plain JSON at the caps at about 4.9 MB. Reproduced here on
// synthetic rows at every cap (1,500 documents, 2,000 equipment items, 300
// projects, 8,000-row link tables, short real-looking names, uuid ids):
//
//   * the plain payload is past the budget (the reproduction);
//   * packed (lib/orgGraph packGraphPayload: an edge names its ends by
//     position) it is within GRAPH_PAYLOAD_BUDGET with every pair carried —
//     and with long titles and descriptions too;
//   * unpackGraphPayload gives back exactly what was packed;
//   * past the budget the pairs are left out (said); past it even alone the
//     map is refused (`tooLarge`), never sent for the platform to cut.

import { describe, it, expect } from "vitest";
import {
  assembleOrgGraph, emptyGraphRows, fitGraphPayload, packGraphPayload, unpackGraphPayload,
  GRAPH_CAPS, GRAPH_PAYLOAD_BUDGET, PAIRS_LEFT_OUT, type OrgGraphPayload,
} from "@/lib/orgGraph";
import { PENDING_PAIRS_CAP } from "@/lib/linkProposals";

/** A uuid-shaped id, deterministic (36 characters, as the real ids are). */
const uid = (kind: number, n: number) => {
  const h = (kind * 1_000_003 + n).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(0, 3)}-8${h.slice(3, 6)}-${h.padStart(12, "a")}`;
};

/** A map at every cap, and PENDING_PAIRS_CAP pairs. `long`: 120-character
 *  titles and descriptions. `marks` (I-32): the worst case of the person-
 *  also and sweep-sheet marks — every machine reading's document also
 *  tagged with its equipment (personAlso), every person's link carrying the
 *  sweep's sheet address (sheetUnconfirmed). */
function atTheCaps(long = false, marks = false): OrgGraphPayload {
  const r = emptyGraphRows();
  const words = (s: string) => (long ? `${s} — ${"suction strainer and discharge isolation ".repeat(3)}`.slice(0, 120) : s);
  r.plants = [{ id: uid(1, 0), name: "Refinery", code: "BR" }];
  for (let i = 0; i < 20; i++) r.codebookUnits.push({ code: String(10 + i), label: `Unit ${10 + i} Crude`, meta: null });
  for (let i = 0; i < 10; i++) r.units.push({ id: uid(2, i), name: `Crude ${i}`, code: `U${i}`, plant_id: r.plants[0].id, codebook_code: String(10 + i) });
  for (let i = 0; i < 20; i++) r.libraries.push({ id: uid(3, i), name: `Library ${i}` });
  for (let i = 0; i < GRAPH_CAPS.LIST_CAP; i++) r.projects.push({ id: uid(4, i), name: `Turnaround project ${i}`, status: "active" });
  for (let i = 0; i < GRAPH_CAPS.DOC_CAP; i++) {
    r.documents.push({
      id: uid(5, i), document_number: `20-PID-${String(i).padStart(4, "0")}`, title: words(`Crude charge pump suction ${i}`),
      library_id: r.libraries[i % 20].id, unit_id: i % 3 === 0 ? r.units[i % 10].id : null, unit_code: String(10 + (i % 20)),
      plant_id: null, system_id: null, sheet_number: null, sheet_total: null,
    });
  }
  for (let i = 0; i < GRAPH_CAPS.ASSET_CAP; i++) {
    r.assets.push({
      id: uid(6, i), tag: `P-${1000 + i}`, description: words(`Charge pump ${i}`), unit_code: String(10 + (i % 20)),
      unit_id: null, plant_id: null, system_id: null, type_id: uid(7, i % 40), library_id: null,
    });
  }
  const D = r.documents, A = r.assets, P = r.projects;
  for (let i = 0; i < GRAPH_CAPS.EDGE_CAP; i++) {
    r.docAssets.push(i % 2
      ? { document_id: D[i % D.length].id, asset_id: A[(i * 7) % A.length].id, source: "drawing", sheet_label: "SHT 4", pages: [4], asserted_by: "machine", model: "vision-x" }
      : { document_id: D[i % D.length].id, asset_id: A[(i * 7) % A.length].id, source: "manual", asserted_by: "human", ...(marks ? { sheet_label: "SHT 7" } : {}) });
    r.projectDocs.push({ project_id: P[i % P.length].id, document_id: D[(i * 3) % D.length].id });
    r.related.push({ document_id: D[i % D.length].id, target_document_id: D[(i * 11 + 1) % D.length].id, kind: "document" });
    r.mentions.push({ asset_id: A[(i * 13) % A.length].id, document_id: D[(i * 5) % D.length].id, knowledge_document_id: null });
    r.flows.push({ from_kind: "asset", from_ref: A[i % A.length].id, to_kind: "asset", to_ref: A[(i * 17 + 3) % A.length].id, status: "confirmed" });
  }
  for (let i = 0; i < D.length - 1; i += 2) r.supersessions.push({ superseded_doc_id: D[i].id, replacement_doc_id: D[i + 1].id });
  if (marks) {
    r.docTags = new Map();
    for (const da of r.docAssets) {
      const tag = A.find((a) => a.id === da.asset_id)!.tag;
      const cur = (r.docTags.get(da.document_id) as Array<{ tag: string }> | undefined) ?? [];
      r.docTags.set(da.document_id, [...cur, { tag }]);
    }
  }
  const graph = assembleOrgGraph(r);
  const pairs = Array.from({ length: PENDING_PAIRS_CAP }, (_, i) => {
    const a = D[i % D.length].id, b = D[(i * 7 + 1) % D.length].id;
    return { documentId: a, targetDocumentId: b, proposer: "co_citation", nodeA: `doc:${a}`, nodeB: `doc:${b}` };
  });
  return { graph, proposals: { pairs, total: PENDING_PAIRS_CAP, capped: false, error: null } };
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const PLATFORM_CAP = 4_500_000;

describe("GAP-313 (fix pass) — the one answer at the caps", () => {
  const p = atTheCaps();

  it("the map really is at the caps", () => {
    expect(p.graph.nodes.filter((n) => n.type === "document")).toHaveLength(GRAPH_CAPS.DOC_CAP);
    expect(p.graph.nodes.filter((n) => n.type === "asset")).toHaveLength(GRAPH_CAPS.ASSET_CAP);
    expect(p.graph.nodes.length).toBeGreaterThan(3800);
    expect(p.graph.edges.length).toBeGreaterThan(21_000);
    expect(p.proposals.pairs).toHaveLength(PENDING_PAIRS_CAP);
  });

  it("reproduction: sent as plain JSON it is past the platform's cap (the answer the review measured)", () => {
    expect(bytes(p.graph)).toBeGreaterThan(3_900_000);
    expect(bytes(p)).toBeGreaterThan(PLATFORM_CAP);
  });

  it("packed, it is within the budget with every pair carried — a budget under the platform's cap", () => {
    expect(GRAPH_PAYLOAD_BUDGET).toBeLessThanOrEqual(4_000_000);
    const fitted = fitGraphPayload(p);
    expect("tooLarge" in fitted).toBe(false);
    if ("tooLarge" in fitted) return;
    expect(fitted.pairsLeftOut).toBe(false);
    expect(fitted.bytes).toBeLessThan(2_400_000); // measured 2,171,422 (plain: 4,920,918)
    expect(fitted.bytes).toBe(new TextEncoder().encode(fitted.body).length);
  });

  it("with 120-character titles and descriptions it is still within the budget, pairs and all", () => {
    const fitted = fitGraphPayload(atTheCaps(true));
    expect("tooLarge" in fitted).toBe(false);
    if (!("tooLarge" in fitted)) {
      expect(fitted.pairsLeftOut).toBe(false);
      expect(fitted.bytes).toBeLessThan(2_800_000); // measured 2,523,642 (plain: 5,273,138)
    }
  });

  it("unpacked, it is exactly the payload that was packed — nothing dropped, nothing invented", () => {
    const fitted = fitGraphPayload(p);
    if ("tooLarge" in fitted) throw new Error("unexpected");
    expect(unpackGraphPayload(JSON.parse(fitted.body))).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it("past the budget the pairs are left out and said; past it even alone the map is refused", () => {
    const packed = bytes(packGraphPayload(p));
    const withoutPairs = bytes(packGraphPayload({ ...p, proposals: { ...p.proposals, pairs: [] } }));
    const left = fitGraphPayload(p, packed - 1);
    expect(left).toMatchObject({ pairsLeftOut: true });
    if ("tooLarge" in left) return;
    expect(unpackGraphPayload(JSON.parse(left.body)).proposals).toEqual({ pairs: [], total: PENDING_PAIRS_CAP, capped: false, error: PAIRS_LEFT_OUT });
    expect(fitGraphPayload(p, withoutPairs - 200)).toEqual({ tooLarge: true, bytes: expect.any(Number) });
  });

  // I-32 merge (DEC-90, ruled by the integrator 2026-10-21): what the
  // person-also and sweep-sheet marks add to the answer.
  it("I-32: an edge carrying personAlso adds 18 bytes on the wire, one carrying sheetUnconfirmed 24 — and the worst case at the caps (every tag edge marked, long titles, every pair) is still within the budget", () => {
    const edge = (extra: Record<string, unknown>) => bytes(packGraphPayload({
      graph: { nodes: [{ id: "doc:d", type: "document", label: "D", href: "/d", degree: 1 }, { id: "asset:a", type: "asset", label: "A", href: "/a", degree: 1 }],
        edges: [{ a: "doc:d", b: "asset:a", type: "tag", sheet: "SHT 4", pages: [4], ...extra }], truncations: [], severed: 0, scope: null },
      proposals: { pairs: [], total: 0, capped: false, error: null },
    } as unknown as OrgGraphPayload).graph.edges[0]);
    expect(edge({ assertedBy: "machine", aiRead: true, personAlso: true }) - edge({ assertedBy: "machine", aiRead: true })).toBe(18); // ,"personAlso":true
    expect(edge({ assertedBy: "human", sheetUnconfirmed: true }) - edge({ assertedBy: "human" })).toBe(24); // ,"sheetUnconfirmed":true
    const plain = fitGraphPayload(atTheCaps(true));
    const marked = atTheCaps(true, true);
    const tagEdges = marked.graph.edges.filter((e) => e.type === "tag");
    expect(tagEdges.filter((e) => e.personAlso).length).toBeGreaterThanOrEqual(3000);
    expect(tagEdges.filter((e) => e.sheetUnconfirmed).length).toBeGreaterThanOrEqual(3000);
    const fitted = fitGraphPayload(marked);
    expect("tooLarge" in fitted || "tooLarge" in plain).toBe(false);
    if ("tooLarge" in fitted || "tooLarge" in plain) return;
    expect(fitted.pairsLeftOut).toBe(false);
    // exactly the marks' bytes, plus the sheet the person's links now carry
    const added = tagEdges.filter((e) => e.personAlso).length * 18 + tagEdges.filter((e) => e.sheetUnconfirmed).length * 24;
    const sheets = tagEdges.filter((e) => e.sheetUnconfirmed).length * bytes({ sheet: "SHT 7", pages: [] }); // upper bound on the sheet fields
    expect(fitted.bytes - plain.bytes).toBeGreaterThan(added);
    expect(fitted.bytes - plain.bytes).toBeLessThanOrEqual(added + sheets);
    expect(fitted.bytes).toBeLessThan(GRAPH_PAYLOAD_BUDGET);
  });

  it("every edge type and every edge field survives the trip", () => {
    const small: OrgGraphPayload = {
      graph: {
        nodes: [{ id: "cbunit:20", type: "unit", label: "Crude", href: "/x", degree: 2, unitCode: "20", unitId: null }, { id: "lib:L", type: "library", label: "L", href: "/l", degree: 1 }, { id: "asset:a", type: "asset", label: "P-1", href: "/a", degree: 1 }],
        edges: [
          { a: "cbunit:20", b: "lib:L", type: "library", via: "pinned", note: "Pinned — L › F", folderIds: ["f1"] },
          { a: "cbunit:20", b: "asset:a", type: "flow" },
          { a: "doc:gone", b: "asset:a", type: "plot" },
        ],
        truncations: ["n"], severed: 0, scope: null,
      },
      proposals: { pairs: [], total: 0, capped: false, error: null },
    };
    const w = packGraphPayload(small);
    expect(w.graph.edges[2]).toEqual(["doc:gone", 2, 9]);
    expect(unpackGraphPayload(JSON.parse(JSON.stringify(w)))).toEqual(small);
  });
});
