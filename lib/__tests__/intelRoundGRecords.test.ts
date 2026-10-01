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
// reads as open — and with only `libraries` failing, a FOLDER under a
// library-level deny is a readable container too (folderChain drops the
// missing library's ACL); and loadPrincipal swallows a failed `team_members`
// read (`teams ?? []`), so the principal carries no teams and a TEAM DENY
// stops applying. Opened as KACL-12 (owner I-12, lib/knowledgeAccess.ts). The
// KACL-12 block reproduces each limb against the real seam as an `it.fails`:
// it asserts what KACL-12's Done-when require, fails at HEAD (the leak), and
// starts failing the suite the day the fix makes it hold, so I-12 flips each
// to `it` as it lands. The stand-in honours `.order()` and `.range()` /
// `.limit()` (filter, sort, then window, as PostgREST does), so when the
// container reads start paging these cases run that loop too; the row-cap
// limb itself (more folders than one window) is KACL-12 Done-when 4 and is not
// reproduced here.
//
// DACL-2 criterion 1 (a key belonging to a held document is refused) did not
// hold for a revision's NATIVE SOURCE file when this file was written:
// /api/storage/delete resolved the key to its version by `file_url` alone, so
// a `source_file_key` matched no row, the hold checks never ran, and the bytes
// were destroyed with a 200. SURF-2's own test (storageDeleteRoute.test.ts)
// then used a filter-blind stand-in that answered every document_versions read
// with the row, so it could not see this; the filter-aware stand-in here did.
// The two cases were held as `it.fails` until document-control fleet package
// P11 STORAGE-DELETE (2026-10-01), which resolves the key against both
// columns as upload-url does; they are now plain `it`.
//
// ILIFE-6 criterion 3 (the orphan collector must never miss a reference —
// deleteOrphans is irreversible): the last block drives the real
// collectReferencedKeys. It paged by OFFSET (`.order("id").range(from,
// from + 999)`) and counted after the loop, so a row the scan already read,
// deleted before the next window, shifted that window by one; the first row
// of the next window was never read and the count still agreed. That case was
// an `it.fails`; admin-and-org P2 (BKP-2) landed keyset paging and flipped it
// to `it`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

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
// lib/storageOrphans (ILIFE-6 block) builds its S3 client at import; the
// collector under test never touches the bucket. The DACL-2 block counts the
// route's DeleteObject sends on the same mock.
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
// The route must refuse before a provider is ever called.
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async () => { db.providerCalls += 1; return { text: "", usage: { inputTokens: 0, outputTokens: 0 } }; }),
  AiCallError: class AiCallError extends Error {},
}));

import { toolByName, type ToolContext } from "@/lib/orchestrator/tools";
import { loadPrincipal, loadDcLandscape, containerReadable, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { POST as orchestratorPOST } from "@/app/api/orchestrator/route";
import { collectReferencedKeys } from "@/lib/storageOrphans";
import { DELETE as storageDELETE } from "@/app/api/storage/delete/route";
import { r2 } from "@/lib/r2";

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

  it("fails CLOSED on the mirror hop: when knowledge_documents cannot be read, every returned knowledge document is hidden", async () => {
    seed(null);
    const viewer = await ctxFor("u-viewer");
    db.errors.knowledge_documents = { message: "timeout" };
    expect(passageDocs(await run("search_documents", { query: "knockout drum" }, viewer))).toEqual([]);
  });
});

describe("KACL-12 (owner I-12): the seam's own reads fail OPEN — it.fails until the fix lands, then flip each to `it`", () => {
  /** What a denied Viewer gets back from both tools: the denied document's
   *  match and its passage, if either leaks. The tools catch a throwing seam
   *  (tools.ts:89, :112), so a fix that throws reads as "nothing leaked". */
  async function leakedTo(viewer: ToolContext): Promise<string[]> {
    const found = await run("find_documents", { query: "flare" }, viewer);
    const searched = await run("search_documents", { query: "knockout drum" }, viewer);
    return [
      ...(matchIds(found).includes(IN_FOLDER) ? ["find_documents: INC-0042"] : []),
      ...(passageDocs(searched).includes("INC-0042") ? ["search_documents: INC-0042 passage"] : []),
    ];
  }

  // ✗ at HEAD (lib/knowledgeAccess.ts:105-125): loadDcLandscape never reads
  // the `error` of either container read, so a failed read is an EMPTY map;
  // the document's chain is evaluated without the missing ACL and the no-ACL
  // fallback (:91) answers readable. Done-when 1 and 6.
  for (const [table, where] of [
    ["collections", "folder"],
    ["libraries", "library"],
  ] as const) {
    // The control, as a plain test so it guards something at HEAD: with
    // every read answering, the deny removes the document.
    it(`control: with every read answering, a ${where}-level deny removes INC-0042 from both tools`, async () => {
      seed(where === "folder" ? (DENY_VIEWER_READ as unknown as Row) : null);
      if (where === "library") db.tables.libraries[0].acl = DENY_VIEWER_READ;
      expect(await leakedTo(await ctxFor("u-viewer"))).toEqual([]);
    });
    it.fails(`a ${table} read error never lets a document under a ${where}-level deny through either tool — nothing controlled comes back, or the seam aborts`, async () => {
      seed(where === "folder" ? (DENY_VIEWER_READ as unknown as Row) : null);
      if (where === "library") db.tables.libraries[0].acl = DENY_VIEWER_READ;
      const viewer = await ctxFor("u-viewer");
      db.errors[table] = { message: "statement timeout" };
      expect(await leakedTo(viewer)).toEqual([]);
    });
  }

  // ✗ at HEAD (lib/knowledgeAccess.ts:36-49): loadPrincipal destructures only
  // `data` from the team_members read, so an error builds a principal with NO
  // teams and a team DENY stops matching. Done-when 2 and 6.
  const TEAM_DENY = { inherit: true, visibility: "normal", rules: [
    { effect: "allow", subject: { type: "role", id: "Viewer" }, actions: ["read", "discover"] },
    { effect: "deny", subject: { type: "team", id: "T-contract" }, actions: ["read", "discover"] },
  ] };
  function seedTeamDeny() {
    seed(TEAM_DENY as unknown as Row);
    db.tables.team_members.push({ uid: "u-viewer", team_id: "T-contract" });
    db.tables.teams.push({ id: "T-contract", org_id: ORG, supervisor_user_id: null });
  }
  // The control, as a plain test: with team_members answering, the Viewer is
  // in T-contract and the deny removes the document.
  it("control: with team_members answering, a team deny on T-contract removes INC-0042 from both tools", async () => {
    seedTeamDeny();
    expect(await leakedTo(await ctxFor("u-viewer"))).toEqual([]);
  });
  it.fails("a team_members read error never drops a team deny — no principal, an abort, or the deny still applies", async () => {
    seedTeamDeny();
    db.errors.team_members = { message: "statement timeout" };
    const outcome = await loadPrincipal(ORG, "u-viewer").then(
      async (p) => {
        if (!p) return "no principal";
        const leaked = await leakedTo({ orgId: ORG, userId: "u-viewer", role: p.role, principal: p, actorName: "Pat Example", approved: new Set() });
        return leaked.length ? `teams [${p.teamIds.join(", ")}] leaked ${leaked.join("; ")}` : "deny applied";
      },
      () => "aborted",
    );
    expect(["no principal", "aborted", "deny applied"].includes(outcome) ? "refused" : outcome).toBe("refused");
  });

  // ✗ at HEAD (lib/knowledgeAccess.ts:188-189): with `libraries` erroring and
  // `collections` read, the folder is in its map and its library is not, so
  // folderChain builds [lib?.acl ?? null, ...lineage] — the library deny drops
  // out and the folder is a readable CONTAINER (the sources picker and
  // add-source re-check, /api/flows/browse, /api/area/knowledge-status name
  // it). Done-when 1, 3 and 6.
  // The control, as a plain test: with every read answering, neither
  // container is readable under the library deny.
  it("control: with every read answering, containerReadable is false for the library and its folder under a library deny", async () => {
    seed(null);
    db.tables.libraries[0].acl = DENY_VIEWER_READ;
    const principal = (await loadPrincipal(ORG, "u-viewer")) as KnowledgePrincipal;
    expect(principal).not.toBeNull();
    const l = await loadDcLandscape(ORG);
    expect([containerReadable("library", LIB, principal, l), containerReadable("folder", FOLDER, principal, l)]).toEqual([false, false]);
  });
  it.fails("a libraries read error never makes a folder under a library-level deny a readable container — refused, or the landscape load aborts", async () => {
    seed(null);
    db.tables.libraries[0].acl = DENY_VIEWER_READ;
    const principal = (await loadPrincipal(ORG, "u-viewer")) as KnowledgePrincipal;
    expect(principal).not.toBeNull();
    const readable = (l: Awaited<ReturnType<typeof loadDcLandscape>>) =>
      [containerReadable("library", LIB, principal, l), containerReadable("folder", FOLDER, principal, l)];
    db.errors.libraries = { message: "statement timeout" };
    const outcome = await loadDcLandscape(ORG).then(
      (l) => {
        const [lib, folder] = readable(l);
        return lib || folder ? `readable: library ${lib}, folder ${folder}` : "refused";
      },
      () => "aborted",
    );
    expect(outcome === "aborted" ? "refused" : outcome).toBe("refused");
  });
});

describe("DACL-2 criterion 1 (→ document-control retention rail): the hold refusal reaches a revision's native source file", () => {
  const ORG_U = "12345678-1234-1234-1234-123456789abc";
  const RENDERED = `orgs/${ORG_U}/libraries/L1/P-101__revC__1.pdf`;
  const SOURCE = `orgs/${ORG_U}/libraries/L1/P-101__revC__source__1.dwg`;
  /** One revision of a held document: its rendered file and its native
   *  source are both keys of the same document_versions row
   *  (lib/revisions.ts:504-510 writes the source under the library prefix,
   *  :528 records it as source_file_key). The caller is a controller by the
   *  role collection, so only the hold check stands between them and the
   *  bytes. */
  function seedHeld(hold: "legal_hold" | "document_holds") {
    db.user = { id: "u-dc", email: "dc@example.com" };
    db.tables = {
      org_members: [{ org_id: ORG_U, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" }],
      document_versions: [{ id: "v-C", record_id: "d-pid", file_url: RENDERED, source_file_key: SOURCE }],
      documents: [{ id: "d-pid", org_id: ORG_U, legal_hold: hold === "legal_hold" }],
      document_holds: hold === "document_holds" ? [{ id: "h-1", document_id: "d-pid", released_at: null }] : [],
    };
  }
  /** The status, plus " deleted" if the route sent a DeleteObject. */
  async function attempt(path: string): Promise<string> {
    vi.mocked(r2.send).mockClear();
    const res = await storageDELETE(new NextRequest("http://test/api/storage/delete", {
      method: "DELETE",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }));
    return `${res.status}${vi.mocked(r2.send).mock.calls.length ? " deleted" : ""}`;
  }

  // Held as `it.fails` until P11 STORAGE-DELETE (2026-10-01). Before it,
  // `.eq("file_url", path)` was the route's only lookup, so the source key
  // matched nothing, documentId stayed null, the legal_hold / document_holds
  // checks were skipped and the route answered 200 after DeleteObject. P11
  // resolves the key against both columns (upload-url's pattern,
  // app/api/storage/upload-url/route.ts:60), so the native-source cases are
  // now plain `it`. The rendered file is the control: it is refused 423 with
  // nothing sent.
  for (const hold of ["legal_hold", "document_holds"] as const) {
    // The control, as a plain test: the rendered file was refused before P11 too.
    it(`control: a document held by ${hold}: its rendered file is refused 423 with nothing sent`, async () => {
      seedHeld(hold);
      expect(await attempt(RENDERED)).toBe("423");
    });
    it(`a document held by ${hold}: its native source file is refused 423 like its rendered file, and nothing is deleted`, async () => {
      seedHeld(hold);
      expect(await attempt(SOURCE)).toBe("423");
    });
  }
});

describe("ILIFE-6 criterion 3 (→ admin-and-org P2, BKP-2): the orphan reference scan under a concurrent delete", () => {
  /** A service-role client for collectReferencedKeys: `document_versions`
   *  holds `rows`, every other source is empty. Reads apply .order("id") and
   *  the .range() / .gt() / .limit() window to the table AS IT IS when the read
   *  runs; a head count answers the table's size at that moment. `afterFirst`
   *  runs once the first window of document_versions has been served — the
   *  concurrent write lands between two windows. */
  function collectorClient(rows: Row[], afterFirst?: (live: Row[]) => void) {
    const live = rows.map((r) => ({ ...r }));
    let windows = 0;
    const from = (table: string) => {
      const src = () => (table === "document_versions" ? live : []);
      let head = false;
      let ordered = false;
      let win: { from: number; to: number } | null = null;
      let after: string | null = null;
      let cap: number | null = null;
      const q: Row = {};
      const h: ProxyHandler<Row> = {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              if (head) return resolve({ data: null, count: src().length, error: null });
              let out = [...src()];
              if (after !== null) out = out.filter((r) => String(r.id) > (after as string));
              if (ordered) out.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
              if (win) out = out.slice(win.from, win.to + 1);
              if (cap !== null) out = out.slice(0, cap);
              if (table === "document_versions") {
                windows += 1;
                if (windows === 1) afterFirst?.(live);
              }
              resolve({ data: out, error: null });
            };
          }
          return (...args: unknown[]) => {
            switch (prop) {
              case "select": head = (args[1] as { head?: boolean } | undefined)?.head === true; break;
              case "order": ordered = args[0] === "id"; break;
              case "range": win = { from: args[0] as number, to: args[1] as number }; break;
              case "gt": after = String(args[1]); break;
              case "limit": cap = args[0] as number; break;
            }
            return new Proxy(q, h);
          };
        },
      };
      return new Proxy(q, h);
    };
    return { client: { from } as unknown as SupabaseClient, live, windows: () => windows };
  }
  const versions = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => {
      const id = `v${String(i + 1).padStart(5, "0")}`;
      return { id, file_url: `orgs/${ORG}/documents/${id}.pdf`, source_file_key: null };
    });

  it("with nothing changing mid-scan, every reference across two 1000-row windows is collected", async () => {
    const h = collectorClient(versions(1500));
    const keys = await collectReferencedKeys(h.client);
    expect(h.windows()).toBe(2);
    expect(keys.size).toBe(1500);
    expect(versions(1500).every((r) => keys.has(r.file_url as string))).toBe(true);
  });

  // Was ✗ (an `it.fails`) on OFFSET windows + a count taken after the loop:
  // deleting v00010 after window 1 moved every later row up one place, window
  // 2 (offset 1000) started at v01002, v01001 was never read, and 1,499 paged
  // = 1,499 counted, so nothing aborted. Flipped to `it` by admin-and-org P2
  // (BKP-2): lib/storageOrphans.ts collectReferencedKeys now pages by KEYSET
  // (`.gt("id", last).order("id").limit(1000)`), so window 2 starts after
  // v01000 whatever was deleted behind it — every live key is read (the
  // delete then shows as 1,500 paged against 1,499 counted, and the scan
  // aborts fail-closed; either outcome satisfies the criterion).
  it("a row deleted after the first window never hides a live reference in the next one — the scan returns every live key or aborts", async () => {
    const h = collectorClient(versions(1500), (live) => { live.splice(9, 1); });
    const outcome = await collectReferencedKeys(h.client).then(
      (keys) => {
        const missed = h.live.filter((r) => !keys.has(r.file_url as string)).map((r) => r.id);
        return missed.length ? `returned without ${missed.join(", ")}` : "complete";
      },
      () => "aborted",
    );
    expect(["complete", "aborted"], outcome).toContain(outcome);
  });
});
