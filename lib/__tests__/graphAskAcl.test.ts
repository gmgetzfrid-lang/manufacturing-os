// intelligence Round G, package I-04 — GPV-1 / IEDGE-1 (CRITICAL): the
// graph's Ask box ran the corpus search on the service role and returned
// passages, page numbers and node ids from knowledge MIRRORS of controlled
// documents the asker may not read. And IEDGE-11 (GPV-12's route half): the
// route's contract promised an "answered" mode it never produced.
//
// This file drives POST /api/graph/ask through the REAL ACL seam
// (lib/knowledgeAccess: loadPrincipal, the library → folder → document
// chain, lib/acl) over the in-memory PostgREST stand-in
// (./knowledgeFakeDb). Only the service-role client is faked; graph_ask's
// rows are what the RPC would return on the service role — every org
// passage, unfiltered.
//
//   * a member with no read on the Legal library gets ZERO hits for a term
//     only that library's mirror holds — no snippet, no page, no node id;
//   * mixed hits: the denied mirror's passages, its document node and the
//     equipment its mentions name are gone, the rest of the corpus answers;
//     a controller (by the role collection) still sees everything;
//   * a mention row naming an unreadable controlled document is dropped even
//     when the knowledge document it came from is upload-origin;
//   * fails CLOSED: when the mirror lookup cannot be read every hit is
//     withheld; when the asker's principal or readable set cannot be built,
//     every source-linked hit is withheld and upload-origin hits stay — and a
//     FAILED check is said as one (503 "couldn't check document access", or
//     a partial-answer note), never as "nothing matches";
//   * the contract is evidence-only (IEDGE-11).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db, resetDb } from "./knowledgeFakeDb";

const net = vi.hoisted(() => ({
  graphAsk: [] as Array<Record<string, unknown>>,
  users: { viewer: "u-viewer", dc: "u-dc", eng: "u-eng" } as Record<string, string>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { fakeAdmin } = await import("./knowledgeFakeDb");
  return {
    supabaseAdmin: {
      from: fakeAdmin.from,
      rpc: async (fn: string) => (fn === "graph_ask"
        ? { data: net.graphAsk, error: null }
        : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
      auth: {
        getUser: async (token: string) => (net.users[token]
          ? { data: { user: { id: net.users[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
      },
    },
  };
});
// lib/ownership (pulled in by lib/knowledgeAccess) imports the browser
// client, the notifier and the audit writer at module load.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));

import { POST } from "@/app/api/graph/ask/route";

const ORG = "o1";
// The Legal library is read by engineers only: an ACL with rules admits only
// what it allows (lib/acl), so a Viewer — no grant — is denied.
const LEGAL_ENGINEERS_ONLY = { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "role", id: "Engineer-1" }, actions: ["read", "discover"] }] };

function seed(): void {
  resetDb({
    org_members: [
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
      { org_id: ORG, uid: "u-eng", role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
    ],
    team_members: [],
    teams: [],
    libraries: [
      { id: "L-legal", org_id: ORG, name: "Legal / HSE", acl: LEGAL_ENGINEERS_ONLY, visibility: "normal", owner_user_id: null, owner_team_id: null },
      { id: "L-ops", org_id: ORG, name: "Operations", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null },
    ],
    collections: [],
    documents: [
      { id: "d-legal", org_id: ORG, library_id: "L-legal", collection_id: null, acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null },
      { id: "d-ops", org_id: ORG, library_id: "L-ops", collection_id: null, acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null },
    ],
    knowledge_documents: [
      { id: "k-legal", org_id: ORG, source_document_id: "d-legal" },
      { id: "k-ops", org_id: ORG, source_document_id: "d-ops" },
      { id: "k-up", org_id: ORG, source_document_id: null },
    ],
    entity_mentions: [
      { org_id: ORG, asset_id: "a-legal", context_snippet: "settlement terms for V-900 relief", mention_count: 4, document_id: "d-legal", knowledge_document_id: "k-legal", confidence: 0.9 },
      { org_id: ORG, asset_id: "a-ops", context_snippet: "E-101 support spacing", mention_count: 2, document_id: "d-ops", knowledge_document_id: "k-ops", confidence: 0.8 },
      { org_id: ORG, asset_id: "a-up", context_snippet: "E-202 note", mention_count: 1, document_id: null, knowledge_document_id: "k-up", confidence: 0.7 },
      // An upload-origin knowledge document whose mention row nevertheless
      // names the restricted controlled document directly.
      { org_id: ORG, asset_id: "a-direct", context_snippet: "the settlement drawing is D-LEGAL", mention_count: 1, document_id: "d-legal", knowledge_document_id: "k-up", confidence: 0.6 },
    ],
  });
}

const HIT = {
  legal: { knowledge_document_id: "k-legal", document_name: "Settlement agreement", library_id: "KL-legal", page: 3, snippet: "the <b>settlement terms</b> of the 2025 incident", rank: 0.9 },
  ops: { knowledge_document_id: "k-ops", document_name: "Pipe support standard", library_id: "KL-ops", page: 7, snippet: "pipe <b>support</b> spacing", rank: 0.5 },
  up: { knowledge_document_id: "k-up", document_name: "Uploaded site note", library_id: "KL-up", page: 1, snippet: "site note on <b>support</b> clamps", rank: 0.3 },
};

async function ask(token: string, question: string) {
  const res = await POST(new NextRequest("http://test/api/graph/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId: ORG, question }),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const hitDocs = (b: Record<string, unknown>) => ((b.hits ?? []) as Array<{ knowledgeDocumentId: string }>).map((h) => h.knowledgeDocumentId).sort();

beforeEach(() => { seed(); net.graphAsk = []; });

describe("GPV-1 / IEDGE-1 — the graph's Ask box reads only what the asker may read", () => {
  it("a member with no read on the Legal library gets ZERO hits for a term only that library holds — no snippet, page or node", async () => {
    net.graphAsk = [HIT.legal];
    const { status, body } = await ask("viewer", "settlement terms");
    expect(status).toBe(200);
    expect(body.hits).toEqual([]);
    expect(body.nodeIds).toEqual([]);
    expect(body.assets).toEqual([]);
    // (The question itself is echoed; nothing of the document is.)
    const text = JSON.stringify({ ...body, question: undefined });
    expect(text).not.toContain("settlement");
    expect(text).not.toContain("Settlement agreement");
    expect(text).not.toContain("d-legal");
    // Indistinguishable from "nothing matched" — the response does not count what it withheld.
    expect(body.note).toMatch(/Nothing in the indexed libraries matches that/);
  });

  it("the same question answered for a controller by the role collection (the deny is what removed it — not the fixture)", async () => {
    net.graphAsk = [HIT.legal];
    const { body } = await ask("dc", "settlement terms");
    expect(hitDocs(body)).toEqual(["k-legal"]);
    expect(body.nodeIds).toEqual(expect.arrayContaining(["doc:d-legal", "asset:a-legal"]));
  });

  it("mixed hits: the denied mirror's passages, document node and equipment are gone; the readable mirror and the upload stay", async () => {
    net.graphAsk = [HIT.legal, HIT.ops, HIT.up];
    const { body } = await ask("viewer", "support");
    expect(hitDocs(body)).toEqual(["k-ops", "k-up"]);
    const nodes = body.nodeIds as string[];
    expect(nodes).toEqual(expect.arrayContaining(["doc:d-ops", "asset:a-ops", "asset:a-up"]));
    expect(nodes).not.toContain("doc:d-legal");
    expect(nodes).not.toContain("asset:a-legal");
    const assets = (body.assets as Array<{ assetId: string; snippet: string }>);
    expect(assets.map((a) => a.assetId).sort()).toEqual(["a-ops", "a-up"]);
    expect(JSON.stringify(body)).not.toContain("settlement");
  });

  it("a mention row naming an unreadable controlled document is dropped even when its knowledge document is upload-origin", async () => {
    net.graphAsk = [HIT.up];
    const viewer = (await ask("viewer", "support")).body;
    expect((viewer.nodeIds as string[])).not.toContain("asset:a-direct");
    expect((viewer.nodeIds as string[])).not.toContain("doc:d-legal");
    expect(JSON.stringify(viewer)).not.toContain("D-LEGAL");
    const dc = (await ask("dc", "support")).body;
    expect((dc.nodeIds as string[])).toEqual(expect.arrayContaining(["asset:a-direct", "doc:d-legal"]));
  });

  it("an engineer the Legal library grants reads its mirror — the filter is the ACL, not a role list", async () => {
    net.graphAsk = [HIT.legal];
    expect(hitDocs((await ask("eng", "settlement terms")).body)).toEqual(["k-legal"]);
  });

  it("fails CLOSED: when the mirror lookup cannot be read, no hit is returned (which hits are mirrors is unknown) — and it says the check failed, not that nothing matches", async () => {
    net.graphAsk = [HIT.legal, HIT.ops, HIT.up];
    db.hooks.push((op) => (op.table === "knowledge_documents" ? { error: { code: "57014", message: "statement timeout" } } : undefined));
    const { status, body } = await ask("dc", "support");
    expect(status).toBe(503);
    expect(body.error).toMatch(/couldn't check document access right now/);
    expect(body).not.toHaveProperty("hits");
    expect(body).not.toHaveProperty("nodeIds");
    expect(JSON.stringify(body)).not.toMatch(/Nothing in the indexed libraries matches/);
    expect(JSON.stringify(body)).not.toMatch(/settlement|support spacing|site note/i);
  });

  it("a principal that cannot be built when EVERY hit is a mirror is a 503 too — a failed check is never shown as 'nothing matches'", async () => {
    net.graphAsk = [HIT.legal, HIT.ops];
    db.hooks.push((op) => (op.table === "org_members" && op.kind === "select" && Array.isArray(op.columns) && op.columns.includes("roles")
      ? { error: { code: "57014", message: "statement timeout" } } : undefined));
    const { status, body } = await ask("dc", "support");
    expect(status).toBe(503);
    expect(body.error).toMatch(/couldn't check document access/);
    expect(JSON.stringify(body)).not.toMatch(/settlement|support spacing/i);
  });

  it("a genuine empty result, and an ACL-filtered one, still read 'nothing matches' (200)", async () => {
    net.graphAsk = [];
    const none = await ask("viewer", "unobtainium");
    expect(none.status).toBe(200);
    expect(none.body.note).toMatch(/Nothing in the indexed libraries matches that/);
    net.graphAsk = [HIT.legal];
    const denied = await ask("viewer", "settlement terms");
    expect(denied.status).toBe(200);
    expect(denied.body.note).toMatch(/Nothing in the indexed libraries matches that/);
  });

  it("fails CLOSED: when the asker's readable set cannot be built, every source-linked hit is withheld and upload-origin hits stay", async () => {
    net.graphAsk = [HIT.legal, HIT.ops, HIT.up];
    // loadPrincipal's member read fails — the route's own membership gate is a
    // different read (`uid`) and still admits the asker.
    db.hooks.push((op) => (op.table === "org_members" && op.kind === "select" && Array.isArray(op.columns) && op.columns.includes("roles")
      ? { error: { code: "57014", message: "statement timeout" } } : undefined));
    const { status, body } = await ask("dc", "support");
    expect(status).toBe(200);
    expect(hitDocs(body)).toEqual(["k-up"]);
    // The answer says it is partial — the linked documents' hits were withheld
    // because the check failed, not because nothing else matched.
    expect(body.note).toMatch(/could not be checked for document access right now and were left out/);
    expect((body.nodeIds as string[])).not.toContain("doc:d-ops");
    expect((body.nodeIds as string[])).not.toContain("doc:d-legal");
    // The upload-origin mention row that names a controlled document directly
    // is withheld too (its readability cannot be confirmed).
    expect((body.nodeIds as string[])).not.toContain("asset:a-direct");
    expect((body.nodeIds as string[])).toContain("asset:a-up");
  });

  it("a mentions read that fails is said as a failure — never 'not linked to equipment yet, run the indexer'", async () => {
    net.graphAsk = [HIT.up];
    db.hooks.push((op) => (op.table === "entity_mentions" ? { error: { code: "57014", message: "statement timeout" } } : undefined));
    const { status, body } = await ask("dc", "support");
    expect(status).toBe(200);
    expect(hitDocs(body)).toEqual(["k-up"]);
    expect(body.nodeIds).toEqual([]);
    expect(body.note).toBe("Couldn't load which equipment these passages mention right now — try again.");
    expect(String(body.note)).not.toMatch(/mention indexer/);
    // A passage genuinely linked to no equipment still gets the indexer advice.
    db.hooks = [];
    db.tables.entity_mentions = [];
    expect((await ask("dc", "support")).body.note).toMatch(/none of these documents are linked to equipment yet — run the mention indexer/);
  });

  it("a stranger is refused before any search runs", async () => {
    net.graphAsk = [HIT.legal];
    const res = await POST(new NextRequest("http://test/api/graph/ask", {
      method: "POST",
      headers: { authorization: "Bearer nobody", "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, question: "settlement terms" }),
    }));
    expect(res.status).toBe(401);
  });
});

describe("IEDGE-11 (GPV-12's route half) — the contract is evidence-only", () => {
  const route = readFileSync(join(process.cwd(), "app/api/graph/ask/route.ts"), "utf8");

  it("no 'answered' mode and no answer field in the exported contract; every payload says evidence", async () => {
    expect(route).not.toMatch(/"answered"/);
    expect(route).not.toMatch(/\banswer:\s*(null|string)/);
    expect(route).toMatch(/mode: "evidence";/);
    net.graphAsk = [HIT.ops];
    const { body } = await ask("viewer", "support");
    expect(body.mode).toBe("evidence");
    expect(body).not.toHaveProperty("answer");
    net.graphAsk = [];
    const empty = (await ask("viewer", "support")).body;
    expect(empty.mode).toBe("evidence");
    expect(empty).not.toHaveProperty("answer");
  });

  it("the header describes the enforcement that runs (no SECURITY INVOKER claim), and the one consumer never branches on a mode", () => {
    expect(route).not.toMatch(/SECURITY INVOKER under the caller's own RLS/);
    expect(route).toMatch(/readableControlledDocIds/);
    expect(route).toMatch(/fail(s)? CLOSED/i);
    const page = readFileSync(join(process.cwd(), "app/(protected)/graph/page.tsx"), "utf8");
    expect(page).not.toMatch(/"answered"/);
    const ask = page.slice(page.indexOf("interface GraphAsk {"), page.indexOf("}", page.indexOf("interface GraphAsk {")));
    expect(ask).toContain("hits:");
    expect(ask).not.toMatch(/\bmode\b|\banswer\b/);
  });
});
