// intelligence Round G, package I-01 phase A (records) — KACL-2 is
// re-verified against roles-and-permissions EGRESS-3 (Round C1), the same
// code IEDGE-2 and ORCH-3 were closed on. EGRESS-3's own proof (sweepRoundC.test.ts) is
// unit-level at the ACL seam: `readableControlledDocIds` is mocked. KACL-2's
// third Done-when asks for more — "a non-controller with an ACL deny on a
// FOLDER gets zero passages and zero matches from both tools for a document
// inside it" — so this file drives the two tools through the REAL seam
// (lib/knowledgeAccess: loadPrincipal, loadDcLandscape, the library → folder
// → document chain, lib/acl) over an in-memory, filter-aware PostgREST
// stand-in. Only the service-role client is faked.
//
//   * the principal is the one loadPrincipal builds (role collection, teams);
//     an inactive or absent membership yields null and the route answers 403
//     before any key, meter or provider is touched — and so does an ACTIVE
//     member whose principal cannot be loaded, although the route's own
//     member read still finds them (the `!principal` limb, Done-when 1);
//   * a folder-level deny, and a folder restricted to a team the caller is
//     not in, both remove the document inside the folder from find_documents
//     AND its mirror's passages from search_documents, while a controller
//     still sees both (non-vacuous) (Done-when 2 and 3);
//   * a failed read of the documents' own ACL rows, or of the mirror hop,
//     fails CLOSED — nothing controlled comes back.
//
// NOT covered here, because it does not hold at HEAD: a failed (or
// row-capped) read of `libraries` / `collections` inside loadDcLandscape is
// swallowed (`libsRes.data ?? []`, `foldersRes.data ?? []`), so the chain is
// evaluated WITHOUT the missing container ACLs and a folder-denied document
// reads as open; and loadPrincipal swallows a failed `team_members` read
// (`teams ?? []`), so the principal carries no teams and a TEAM DENY stops
// applying. Opened as KACL-12 (owner I-12, lib/knowledgeAccess.ts); the two
// it.todo entries below are the tests that land with that fix.
//
// The stand-in honours `.order()` and `.range()` / `.limit()` (sort, then
// slice), so a fix that pages a read until it comes back short terminates
// here as it would against PostgREST.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string }>,
  /** Tables whose `.in(...)`-filtered reads error (the seam's own reads). */
  failIn: new Set<string>(),
  /** "table|columns": a read of `table` selecting exactly `columns` errors —
   *  one read of a table fails while another read of it succeeds. */
  failSelect: new Set<string>(),
  rpc: [] as Array<Record<string, unknown>>,
  user: null as null | { id: string; email?: string },
  providerCalls: 0,
}));

/** A PostgREST chain that applies the filters the code under test uses. */
function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  let win: { from: number; to: number } | null = null;
  let cap: number | null = null;
  let usedIn = false;
  let columns = "*";
  const cmp = (a: unknown, b: unknown) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
  // PostgREST order of operations: filter, sort, then the range / limit window.
  const rows = () => {
    let out = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (orders.length) {
      out = [...out].sort((a, b) => {
        for (const o of orders) {
          const c = cmp(a[o.col], b[o.col]);
          if (c) return o.asc ? c : -c;
        }
        return 0;
      });
    }
    if (win) out = out.slice(win.from, win.to + 1);
    if (cap !== null) out = out.slice(0, cap);
    return out;
  };
  const failed = () => db.errors[table]
    ?? (usedIn && db.failIn.has(table) ? { message: "statement timeout" } : null)
    ?? (db.failSelect.has(`${table}|${columns}`) ? { message: "statement timeout" } : null);
  const result = () => (failed() ? { data: null, error: failed() } : { data: rows(), error: null });
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": preds.push((r) => r[args[0] as string] === args[1]); break;
          case "neq": preds.push((r) => r[args[0] as string] !== args[1]); break;
          case "in": usedIn = true; preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); break;
          case "is": preds.push((r) => (args[1] === null ? r[args[0] as string] == null : r[args[0] as string] === args[1])); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is" && val === null) preds.push((r) => r[col] != null);
            break;
          }
          case "select": columns = String(args[0] ?? "*"); break;
          case "order": orders.push({ col: args[0] as string, asc: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false }); break;
          case "range": win = { from: args[0] as number, to: args[1] as number }; break;
          case "limit": cap = args[0] as number; break;
          case "maybeSingle": case "single": {
            const out = result();
            return Promise.resolve(out.error ? out : { data: (out.data as Row[])[0] ?? null, error: null });
          }
          // or / ilike / textSearch: the stand-in admits every row the other
          // filters admit — the ACL is what is under test, not the search.
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: db.rpc, error: null }),
    auth: { getUser: async () => ({ data: { user: db.user }, error: db.user ? null : { message: "no session" } }) },
  },
}));
// lib/ownership (pulled in by lib/knowledgeAccess) imports the browser
// client, the notifier and the audit writer at module load.
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
// The route must refuse before a provider is ever called.
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async () => { db.providerCalls += 1; return { text: "", usage: { inputTokens: 0, outputTokens: 0 } }; }),
  AiCallError: class AiCallError extends Error {},
}));

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { toolByName, type ToolContext } from "@/lib/orchestrator/tools";
import { loadPrincipal, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { POST as orchestratorPOST } from "@/app/api/orchestrator/route";

const ORG = "o1";
const LIB = "L-ops";
const FOLDER = "F-incident";
const IN_FOLDER = "d-incident-report";
const AT_ROOT = "d-flare-std";

function seed(folderAcl: Row | null, folderVisibility = "normal") {
  db.tables = {
    org_members: [
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
      { org_id: ORG, uid: "u-gone", role: "Viewer", roles: ["Viewer"], status: "suspended" },
    ],
    team_members: [{ uid: "u-eng", team_id: "T-eng" }],
    teams: [{ id: "T-eng", org_id: ORG, supervisor_user_id: null }],
    libraries: [{ id: LIB, org_id: ORG, name: "Operations", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    collections: [{
      id: FOLDER, org_id: ORG, library_id: LIB, parent_id: null, name: "Legal Hold / Incident",
      acl: folderAcl, visibility: folderVisibility, owner_user_id: null, path_names: ["Legal Hold / Incident"], deleted_at: null,
    }],
    documents: [
      { id: IN_FOLDER, org_id: ORG, library_id: LIB, collection_id: FOLDER, document_number: "INC-0042", title: "Flare KO drum incident report",
        rev: "A", status: "Issued", ai_excluded: false, acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null, updated_at: "2026-09-01" },
      { id: AT_ROOT, org_id: ORG, library_id: LIB, collection_id: null, document_number: "STD-0007", title: "Flare header standard",
        rev: "C", status: "Issued", ai_excluded: false, acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null, updated_at: "2026-08-01" },
    ],
    // k1 mirrors the document inside the folder, k2 the one at the root,
    // k3 is an upload-origin knowledge document (no controlled source).
    knowledge_documents: [
      { id: "k1", org_id: ORG, source_document_id: IN_FOLDER },
      { id: "k2", org_id: ORG, source_document_id: AT_ROOT },
      { id: "k3", org_id: ORG, source_document_id: null },
    ],
  };
  db.rpc = [
    { knowledge_document_id: "k1", document_name: "INC-0042", page: 2, snippet: "the flare <b>knockout drum</b> overfilled during the trip" },
    { knowledge_document_id: "k2", document_name: "STD-0007", page: 5, snippet: "size the <b>knockout drum</b> for the governing relief case" },
    { knowledge_document_id: "k3", document_name: "Site note", page: 1, snippet: "knockout drum level glass replaced" },
  ];
}

async function ctxFor(uid: string): Promise<ToolContext> {
  const principal = await loadPrincipal(ORG, uid);
  expect(principal, `an active member (${uid}) loads a principal`).not.toBeNull();
  const p = principal as KnowledgePrincipal;
  return { orgId: ORG, userId: uid, role: p.role, principal: p, actorName: "Pat Example", approved: new Set() };
}
const run = (name: string, args: Record<string, string | number | boolean>, ctx: ToolContext) => toolByName(name)!.run(args, ctx);
const matchIds = (out: { data: unknown }) => (out.data as { matches: Array<{ document_id: string }> }).matches.map((m) => m.document_id).sort();
const passageDocs = (out: { data: unknown }) => (out.data as { passages: Array<{ document: string }> }).passages.map((p) => p.document).sort();

const DENY_VIEWER_READ = { inherit: true, visibility: "normal", rules: [{ effect: "deny", subject: { type: "role", id: "Viewer" }, actions: ["read", "discover"] }] };
const ENGINEERING_ONLY = { inherit: true, visibility: "hidden", rules: [{ effect: "allow", subject: { type: "team", id: "T-eng" }, actions: ["read", "discover"] }] };

beforeEach(() => {
  db.tables = {}; db.errors = {}; db.failIn = new Set(); db.failSelect = new Set(); db.rpc = []; db.user = null; db.providerCalls = 0;
});

describe("the PostgREST stand-in", () => {
  it("sorts by .order() and windows by .range(), so a read paged until it comes back empty terminates with every row once", async () => {
    seed(null);
    db.tables.collections = ["F-3", "F-1", "F-2"].map((id) => ({ id, org_id: ORG }));
    const seen: string[] = [];
    for (let from = 0, pages = 0; ; from += 2, pages += 1) {
      expect(pages, "the page loop terminates").toBeLessThan(5);
      const { data } = await supabaseAdmin.from("collections").select("*").eq("org_id", ORG).order("id").range(from, from + 1);
      if (!data?.length) break;
      seen.push(...(data as Row[]).map((r) => r.id as string));
    }
    expect(seen).toEqual(["F-1", "F-2", "F-3"]);
  });
});

describe("KACL-2 (→ R&P EGRESS-3) — Done-when 1: the principal is loadPrincipal's, and the route 403s without one", () => {
  it("loadPrincipal carries the role COLLECTION; an inactive or absent member has no principal", async () => {
    seed(null);
    const dc = await loadPrincipal(ORG, "u-dc");
    expect(dc).toMatchObject({ role: "Requester", isController: true });
    expect(dc!.roles.sort()).toEqual(["DocCtrl", "Requester"]);
    expect(await loadPrincipal(ORG, "u-gone")).toBeNull();
    expect(await loadPrincipal(ORG, "u-stranger")).toBeNull();
  });

  it("/api/orchestrator answers 403 for a suspended member and for a stranger, before any provider call", async () => {
    seed(null);
    for (const uid of ["u-gone", "u-stranger"]) {
      db.user = { id: uid };
      const res = await orchestratorPOST(new NextRequest("http://test/api/orchestrator", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ orgId: ORG, question: "what does the incident report say about the flare knockout drum?" }),
      }));
      expect(res.status, uid).toBe(403);
      expect(await res.json()).toEqual({ error: "Not a member of this workspace" });
    }
    expect(db.providerCalls).toBe(0);
  });

  it("/api/orchestrator answers 403 for an ACTIVE member whose principal cannot be loaded, though its own member read finds them", async () => {
    seed(null);
    // loadPrincipal's read (`role, roles`) fails; the route's second read of
    // the same row (`uid, role, display_name, email`) succeeds — so only the
    // `!principal` limb of route.ts's guard can refuse this caller.
    db.failSelect.add("org_members|role, roles");
    expect(await loadPrincipal(ORG, "u-viewer")).toBeNull();
    db.user = { id: "u-viewer" };
    const res = await orchestratorPOST(new NextRequest("http://test/api/orchestrator", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, question: "what does the incident report say about the flare knockout drum?" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not a member of this workspace" });
    expect(db.providerCalls).toBe(0);
  });
});

describe("KACL-2 (→ R&P EGRESS-3) — Done-when 2 and 3: a FOLDER-level ACL removes the document from both read tools", () => {
  for (const [label, acl, visibility] of [
    ["a deny-read rule on the folder naming the caller's role", DENY_VIEWER_READ, "normal"],
    ["a folder restricted to a team the caller is not in", ENGINEERING_ONLY, "hidden"],
  ] as const) {
    it(`${label}: zero matches and zero passages for the document inside it; the rest of the library still answers`, async () => {
      seed(acl as unknown as Row, visibility);
      const viewer = await ctxFor("u-viewer");

      const found = await run("find_documents", { query: "flare" }, viewer);
      expect(matchIds(found)).toEqual([AT_ROOT]);
      expect(JSON.stringify(found.data)).not.toContain("INC-0042");

      const searched = await run("search_documents", { query: "knockout drum" }, viewer);
      expect(passageDocs(searched)).toEqual(["STD-0007", "Site note"]);
      expect(JSON.stringify(searched.data)).not.toContain("overfilled");
    });

    it(`${label}: a controller by the role collection (Requester + DocCtrl) still sees both — the filter is the ACL, not the fixture`, async () => {
      seed(acl as unknown as Row, visibility);
      const dc = await ctxFor("u-dc");
      expect(matchIds(await run("find_documents", { query: "flare" }, dc))).toEqual([AT_ROOT, IN_FOLDER].sort());
      expect(passageDocs(await run("search_documents", { query: "knockout drum" }, dc))).toEqual(["INC-0042", "STD-0007", "Site note"]);
    });
  }

  it("with no ACL anywhere the viewer reads both (the deny above is what removed the document)", async () => {
    seed(null);
    const viewer = await ctxFor("u-viewer");
    expect(matchIds(await run("find_documents", { query: "flare" }, viewer))).toEqual([AT_ROOT, IN_FOLDER].sort());
    expect(passageDocs(await run("search_documents", { query: "knockout drum" }, viewer))).toEqual(["INC-0042", "STD-0007", "Site note"]);
  });

  it("fails CLOSED: when the seam cannot read the documents' own ACL rows, nothing controlled is returned (upload-origin passages only)", async () => {
    seed(null);
    const viewer = await ctxFor("u-viewer");
    // find_documents' own candidate query still succeeds (it is not an
    // `.in("id", …)` read); only readableControlledDocIds' row read fails.
    db.failIn.add("documents");
    expect(matchIds(await run("find_documents", { query: "flare" }, viewer))).toEqual([]);
    expect(passageDocs(await run("search_documents", { query: "knockout drum" }, viewer))).toEqual(["Site note"]);
  });

  it.todo("KACL-12 (owner I-12): a libraries / collections read error inside loadDcLandscape fails CLOSED — today it drops the container ACL and the folder-denied document reads as open");
  it.todo("KACL-12 (owner I-12): a team_members read error inside loadPrincipal yields no principal (or throws to a fail-closed caller) — today the principal loads with no teams, so a folder ACL [allow role Viewer read, deny team T read] reads as open to a Viewer in T");

  it("fails CLOSED on the mirror hop: when knowledge_documents cannot be read, every returned knowledge document is hidden", async () => {
    seed(null);
    const viewer = await ctxFor("u-viewer");
    db.errors.knowledge_documents = { message: "timeout" };
    expect(passageDocs(await run("search_documents", { query: "knockout drum" }, viewer))).toEqual([]);
  });
});
