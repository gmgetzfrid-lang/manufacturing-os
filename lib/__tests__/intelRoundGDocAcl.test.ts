// intelligence Round G, package I-12 DOCUMENT ACL BOUNDARY — one read
// predicate for the AI seam, the bytes door and the explorer.
//
// Everything here runs the REAL code (lib/knowledgeAccess, lib/permissions,
// lib/acl, lib/docFileServer, /api/storage/download-url and the four direct
// landscape callers) over an in-memory, filter-aware PostgREST stand-in.
// Only the service-role client, the R2 presigner and the knowledge ingest
// engine (which the sync imports for its rev-up reset) are faked.
//
//   KACL-3   a HIDDEN node needs `read` — discover-only never makes it
//            AI-readable (and a container the same).
//   KACL-11  with no ACL anywhere, a PRIVATE node is not readable (the
//            app's canDiscover fallback).
//   KACL-12  the seam fails CLOSED on its own reads: a failed container or
//            teams read, a rung missing from the landscape, a row cap; the
//            direct landscape callers answer 503 / skip the library.
//   KACL-5   the bytes door decides on the full chain, on every visibility,
//            and fails closed for a key behind a record.
//   IEDGE-12 the AI seam (readableControlledDocIds — the ask route's
//            exclusion set) and the bytes door agree on the same
//            document / principal pairs.
//   DACL-6   a chain made only of zero-rule normal ACLs is "no ACL" — the
//            library is not blanked; the DB's answer.
//   KACL-10  the sync fails closed on an errored held-back read and removes
//            a mirror whose document was held back while it ran.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string; code?: string }>,
  /** "table|column": an .eq(column, …) read of `table` errors with this. */
  failEq: {} as Record<string, { message: string; code?: string }>,
  /** PostgREST max-rows: no response carries more rows than this. */
  maxRows: 100000,
  rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  deletes: [] as Array<{ table: string; ids: unknown[] }>,
  user: null as null | { id: string; email?: string },
  signed: 0,
  /** Called after the sync's first held-back read — the race window. */
  afterFirstHeldRead: null as null | (() => void),
  heldReads: 0,
}));

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  let win: { from: number; to: number } | null = null;
  let cap: number | null = null;
  let op: "select" | "delete" | "insert" = "select";
  let payload: unknown = null;
  const eqCols: string[] = [];
  const cmp = (a: unknown, b: unknown) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
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
    return out.slice(0, db.maxRows);
  };
  const failed = () => db.errors[table] ?? eqCols.map((c) => db.failEq[`${table}|${c}`]).find(Boolean) ?? null;
  const result = () => {
    const err = failed();
    if (err) return { data: null, error: err };
    if (op === "insert") {
      db.inserts.push({ table, row: payload });
      const added = (Array.isArray(payload) ? payload : [payload]) as Row[];
      db.tables[table] = [...(db.tables[table] ?? []), ...added.map((r, i) => ({ id: r.id ?? `${table}-${(db.tables[table] ?? []).length + i + 1}`, ...r }))];
      return { data: null, error: null };
    }
    if (op === "delete") {
      const hit = rows();
      db.deletes.push({ table, ids: hit.map((r) => r.id) });
      db.tables[table] = (db.tables[table] ?? []).filter((r) => !hit.includes(r));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (table === "documents" && eqCols.includes("ai_excluded")) {
      db.heldReads += 1;
      const out = { data: rows(), error: null };
      if (db.heldReads === 1 && db.afterFirstHeldRead) db.afterFirstHeldRead();
      return out;
    }
    return { data: rows(), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": eqCols.push(args[0] as string); preds.push((r) => r[args[0] as string] === args[1]); break;
          case "neq": preds.push((r) => r[args[0] as string] !== args[1]); break;
          case "in": preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); break;
          case "is": preds.push((r) => (args[1] === null ? r[args[0] as string] == null : r[args[0] as string] === args[1])); break;
          case "not": {
            const [col, o, val] = args as [string, string, unknown];
            if (o === "is" && val === null) preds.push((r) => r[col] != null);
            break;
          }
          case "order": orders.push({ col: args[0] as string, asc: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false }); break;
          case "range": win = { from: args[0] as number, to: args[1] as number }; break;
          case "limit": cap = args[0] as number; break;
          case "delete": op = "delete"; break;
          case "insert": op = "insert"; payload = args[0]; break;
          case "maybeSingle": case "single": {
            const out = result();
            return Promise.resolve(out.error ? out : { data: (out.data as Row[])[0] ?? null, error: null });
          }
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
    rpc: async (fn: string, args: Record<string, unknown>) => ({ data: db.rpc[fn] ? db.rpc[fn](args) : null, error: null }),
    auth: { getUser: async () => ({ data: { user: db.user }, error: db.user ? null : { message: "no session" } }) },
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn(async () => { db.signed += 1; return "https://signed.example/get"; }) }));
vi.mock("@/lib/knowledgeIngest", () => ({
  resetKnowledgeIndex: vi.fn(async () => ({ reset: [], busy: [], errors: [] })),
  isMissingColumn: (e: { code?: string } | null) => !!e && (e.code === "42703" || e.code === "PGRST204"),
}));

import {
  loadPrincipal, loadDcLandscape, containerReadable, readableControlledDocIds, chainReadable,
  DcLandscapeUnreadableError, DC_LANDSCAPE_PAGE, type KnowledgePrincipal,
} from "@/lib/knowledgeAccess";
import { canReadNode, canServeContent, canDiscover, canWithAclChain, canReadViaIndex, type Principal } from "@/lib/permissions";
import { evaluateAclChain, aclSaysSomething, buildAclIndexFromChain } from "@/lib/acl";
import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import { GET as flowsBrowse } from "@/app/api/flows/browse/route";
import { GET as areaStatus } from "@/app/api/area/knowledge-status/route";
import { GET as sourcesGET, POST as sourcesPOST } from "@/app/api/knowledge/sources/route";
import { syncKnowledgeLibrarySources, syncAllKnowledgeSources } from "@/lib/knowledgeSourceSync";
import type { AccessControl } from "@/types/schema";

const ORG = "12345678-1234-1234-1234-123456789abc";
const LIB = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const KEY = `orgs/${ORG}/libraries/${LIB}/HSE-7.pdf`;

const allow = (type: string, id: string, actions: string[]) => ({ effect: "allow", subject: { type, id }, actions });
const deny = (type: string, id: string, actions: string[]) => ({ effect: "deny", subject: { type, id }, actions });
const acl = (rules: unknown[], visibility = "normal", inherit = true) => ({ inherit, visibility, rules });

function seed(opts: {
  libAcl?: unknown; libVisibility?: string;
  folderAcl?: unknown; folderVisibility?: string;
  docAcl?: unknown; docVisibility?: string; docIndex?: unknown;
  teams?: string[];
} = {}) {
  db.tables = {
    org_members: [
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
    ],
    team_members: (opts.teams ?? []).map((t) => ({ uid: "u-viewer", team_id: t })),
    teams: [{ id: "T-eng", org_id: ORG, supervisor_user_id: null }],
    libraries: [{ id: LIB, org_id: ORG, name: "Operations", acl: opts.libAcl ?? null, visibility: opts.libVisibility ?? "normal", owner_user_id: null, owner_team_id: null }],
    collections: [{
      id: FOLDER, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: "Incident", path_names: ["Incident"],
      acl: opts.folderAcl ?? null, visibility: opts.folderVisibility ?? "normal", owner_user_id: null, deleted_at: null,
    }],
    documents: [{
      id: DOC, org_id: ORG, library_id: LIB, collection_id: FOLDER, document_number: "HSE-7", title: "Incident procedure",
      acl: opts.docAcl ?? null, visibility: opts.docVisibility ?? "normal", acl_index: opts.docIndex ?? null,
      is_private: false, scope: null, created_by: "u-dc", owner_user_id: null,
      status: "Issued", archived_at: null, current_version_id: "v1", ai_excluded: false, name: null,
    }],
    document_versions: [{ id: "v1", record_id: DOC, file_url: KEY, file_type: "application/pdf", archived_at: null, archive_id: null, revision_label: "A", size: 10 }],
    archive_settings: [],
    audit_logs: [],
  };
  db.errors = {};
  db.failEq = {};
  db.maxRows = 100000;
  db.rpc = { user_is_effective_owner: () => false };
  db.inserts = [];
  db.deletes = [];
  db.signed = 0;
  db.user = { id: "u-viewer", email: "v@example.com" };
  db.afterFirstHeldRead = null;
  db.heldReads = 0;
}

const viewer = async () => (await loadPrincipal(ORG, "u-viewer")) as KnowledgePrincipal;
const aiReads = async () => [...await readableControlledDocIds(await viewer(), [DOC])].includes(DOC);
async function bytes(uid = "u-viewer"): Promise<number> {
  db.user = { id: uid, email: `${uid}@example.com` };
  const res = await downloadUrl(new NextRequest(
    `https://app/api/storage/download-url?path=${encodeURIComponent(KEY)}`,
    { headers: { authorization: "Bearer t" } },
  ));
  return res.status;
}
const restrictedReads = () => db.inserts.filter((i) => i.table === "audit_logs" && (i.row as Row).action === "CONTROLLER_RESTRICTED_READ").length;

beforeEach(() => seed());

describe("KACL-3 — a HIDDEN node needs read: discover-only never makes its text AI-readable", () => {
  it("reproduction → fix: a hidden document with a discover-only grant is NOT in readableControlledDocIds; discover + read is", async () => {
    seed({ docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["discover"])], "hidden") });
    expect(await aiReads()).toBe(false);
    seed({ docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["discover", "read"])], "hidden") });
    expect(await aiReads()).toBe(true);
  });
  it("…and an inherited discover-only grant on a hidden FOLDER is not a read of the document inside it", async () => {
    seed({ folderVisibility: "hidden", folderAcl: acl([allow("role", "Viewer", ["discover"])], "hidden"), docVisibility: "hidden" });
    expect(await aiReads()).toBe(false);
  });
  it("the latent divergence (a hidden column, a normal merged chain): a bare upload / editMetadata grant is not a read either", async () => {
    seed({ docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["upload", "editMetadata", "createFolder"])], "normal") });
    expect(await aiReads()).toBe(false);
  });
  it("containerReadable has the same construct fixed: a hidden folder with discover-only is not a readable container", async () => {
    seed({ folderVisibility: "hidden", folderAcl: acl([allow("role", "Viewer", ["discover"])], "hidden") });
    const l = await loadDcLandscape(ORG);
    expect(containerReadable("folder", FOLDER, await viewer(), l)).toBe(false);
    seed({ folderVisibility: "hidden", folderAcl: acl([allow("role", "Viewer", ["discover", "read"])], "hidden") });
    expect(containerReadable("folder", FOLDER, await viewer(), await loadDcLandscape(ORG))).toBe(true);
  });
  it("regression: a controller and the effective owner still read a hidden document with no grant", async () => {
    seed({ docVisibility: "hidden", docAcl: acl([], "hidden") });
    expect([...await readableControlledDocIds((await loadPrincipal(ORG, "u-dc"))!, [DOC])]).toEqual([DOC]);
    db.tables.documents[0].owner_user_id = "u-viewer";
    expect(await aiReads()).toBe(true);
  });
});

describe("KACL-11 — with no ACL anywhere a PRIVATE node is not readable (canDiscover's fallback)", () => {
  it("readableControlledDocIds: private + acl NULL is excluded; normal + acl NULL stays readable (regression)", async () => {
    seed({ docVisibility: "private" });
    expect(await aiReads()).toBe(false);
    seed();
    expect(await aiReads()).toBe(true);
  });
  it("containerReadable: a private library / folder with no acl is not offered; a normal one is", async () => {
    seed({ libVisibility: "private" });
    let l = await loadDcLandscape(ORG);
    expect(containerReadable("library", LIB, await viewer(), l)).toBe(false);
    seed({ folderVisibility: "private" });
    l = await loadDcLandscape(ORG);
    expect(containerReadable("folder", FOLDER, await viewer(), l)).toBe(false);
    expect(containerReadable("library", LIB, await viewer(), l)).toBe(true);
  });
  it("the seam asks the one predicate: chainReadable answers what canReadNode answers (read) on a matrix", async () => {
    const p = await viewer();
    const P: Principal = { uid: p.uid, role: p.role, roles: p.roles, orgId: p.orgId, teamIds: p.teamIds, isActiveMember: true };
    const chains: Array<Array<AccessControl | null>> = [
      [], [null], [acl([]) as AccessControl], [acl([allow("role", "Viewer", ["read"])]) as AccessControl],
      [acl([allow("role", "Viewer", ["discover"])], "hidden") as AccessControl],
      [acl([deny("role", "Viewer", ["read"]), allow("org", ORG, ["read"])]) as AccessControl],
    ];
    for (const ch of chains) for (const vis of ["normal", "private", "hidden", null] as const) {
      expect(chainReadable(ch, vis, p), JSON.stringify([ch, vis])).toBe(canReadNode({ principal: P, aclChain: ch, visibility: vis, actions: ["read"] }));
    }
  });
});

describe("KACL-12 — the seam fails CLOSED on its own reads", () => {
  it("done-when 1: a libraries or collections read error throws DcLandscapeUnreadableError — no chain is ever evaluated from a partial landscape", async () => {
    for (const t of ["libraries", "collections", "teams"]) {
      seed({ folderAcl: acl([deny("role", "Viewer", ["read"])]) });
      db.errors[t] = { message: "statement timeout" };
      await expect(loadDcLandscape(ORG)).rejects.toBeInstanceOf(DcLandscapeUnreadableError);
      await expect(readableControlledDocIds(await viewer(), [DOC])).rejects.toThrow(/could not be read: statement timeout/);
    }
  });
  it("done-when 2: a team_members read error yields no principal for a non-controller (a team deny is never dropped); a controller still loads", async () => {
    seed({ teams: ["T-contract"] });
    db.errors.team_members = { message: "statement timeout" };
    expect(await loadPrincipal(ORG, "u-viewer")).toBeNull();
    const dc = await loadPrincipal(ORG, "u-dc");
    expect(dc).toMatchObject({ isController: true, teamIds: [] });
  });
  it("done-when 3: a document whose folder is absent from the landscape, or whose folder's ancestor is, is unreadable; a folder whose library is absent is not a readable container", async () => {
    seed();
    db.tables.documents[0].collection_id = "99999999-9999-4999-8999-999999999999";
    expect(await aiReads()).toBe(false);
    seed();
    db.tables.collections[0].parent_id = "88888888-8888-4888-8888-888888888888";
    expect(await aiReads()).toBe(false);
    const l = await loadDcLandscape(ORG);
    expect(containerReadable("folder", FOLDER, await viewer(), l)).toBe(false);
    seed();
    db.tables.collections[0].library_id = "77777777-7777-4777-8777-777777777777";
    expect(containerReadable("folder", FOLDER, await viewer(), await loadDcLandscape(ORG))).toBe(false);
    // control: the same landscape, whole, reads
    seed();
    expect(await aiReads()).toBe(true);
  });
  it("done-when 3 (trash): a folder in the 30-day trash is never offered, but its deny still binds the document below it", async () => {
    seed({ folderAcl: acl([deny("role", "Viewer", ["read"])]) });
    db.tables.collections[0].deleted_at = "2026-10-01T00:00:00Z";
    const l = await loadDcLandscape(ORG);
    expect(l.folders.has(FOLDER)).toBe(false);
    expect(containerReadable("folder", FOLDER, await viewer(), l)).toBe(false);
    expect(await aiReads()).toBe(false);
  });
  it("done-when 4: the container reads page until a short page — with a row cap below the folder count, the folder past the cap keeps its deny", async () => {
    seed();
    const extra = Array.from({ length: DC_LANDSCAPE_PAGE + 300 }, (_, i) => ({
      id: `f-${String(i).padStart(5, "0")}`, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: `F${i}`, path_names: [`F${i}`],
      acl: null, visibility: "normal", owner_user_id: null, deleted_at: null,
    }));
    const last = extra[extra.length - 1];
    last.acl = acl([deny("role", "Viewer", ["read"])]) as never;
    db.tables.collections.push(...extra);
    db.tables.documents[0].collection_id = last.id;
    db.maxRows = DC_LANDSCAPE_PAGE; // PostgREST max-rows
    const l = await loadDcLandscape(ORG);
    expect(l.folders.size).toBe(extra.length + 1);
    expect(await aiReads()).toBe(false);
    last.acl = null as never;
    expect(await aiReads()).toBe(true);
  });

  it("done-when 5: /api/flows/browse answers 503 when the landscape cannot be read (never the tree)", async () => {
    seed();
    db.tables.knowledge_libraries = [];
    db.tables.knowledge_documents = [];
    db.tables.knowledge_sources = [];
    db.errors.collections = { message: "statement timeout" };
    const res = await flowsBrowse(new NextRequest(`https://app/api/flows/browse?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("Incident");
  });
  it("done-when 5: /api/area/knowledge-status answers 503 when the landscape cannot be read", async () => {
    seed();
    db.tables.codebook_entries = [{ org_id: ORG, kind: "unit", code: "200", label: "Crude", meta: {} }];
    db.tables.knowledge_libraries = [];
    db.errors.libraries = { message: "statement timeout" };
    const res = await areaStatus(new NextRequest(`https://app/api/area/knowledge-status?orgId=${ORG}&unitCode=200`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(503);
  });
  it("done-when 5: /api/knowledge/sources browse and add answer 503 when the landscape cannot be read; with it whole, browse offers the containers (regression)", async () => {
    seed();
    const browse = () => sourcesGET(new NextRequest(`https://app/api/knowledge/sources?orgId=${ORG}&action=browse`, { headers: { authorization: "Bearer t" } }));
    const ok = await browse();
    expect(ok.status).toBe(200);
    expect((await ok.json()).folders.map((f: { id: string }) => f.id)).toEqual([FOLDER]);
    db.errors.collections = { message: "statement timeout" };
    expect((await browse()).status).toBe(503);
    db.user = { id: "u-dc", email: "dc@example.com" };
    db.tables.knowledge_libraries = [{ id: "kl-1", org_id: ORG, name: "KL" }];
    const add = await sourcesPOST(new NextRequest("https://app/api/knowledge/sources", {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, libraryId: "kl-1", add: [{ type: "folder", id: FOLDER }] }),
    }));
    expect(add.status).toBe(503);
    expect(db.inserts.filter((i) => i.table === "knowledge_sources")).toEqual([]);
  });
  it("done-when 5: the sync neither reconciles nor removes a library's mirrors on a failed landscape read, and one library's failure does not stop the others", async () => {
    seed();
    db.tables.knowledge_sources = [
      { id: "s1", org_id: ORG, library_id: "kl-1", source_type: "library", source_id: LIB, source_name: "Operations", last_synced_at: null },
      { id: "s2", org_id: ORG, library_id: "kl-2", source_type: "library", source_id: LIB, source_name: "Operations", last_synced_at: "2026-10-01" },
    ];
    db.tables.knowledge_documents = [{ id: "k1", org_id: ORG, library_id: "kl-1", source_id: "s1", source_document_id: DOC, source_version_id: "v1" }];
    db.errors.collections = { message: "statement timeout" };
    const one = await syncKnowledgeLibrarySources("kl-1");
    expect(one).toMatchObject({ added: 0, removed: 0, refreshed: 0 });
    expect(one.errors.join(" ")).toMatch(/landscape: .*not reconciled/);
    expect(db.tables.knowledge_documents.map((k) => k.id)).toEqual(["k1"]);
    const all = await syncAllKnowledgeSources({ deadlineMs: Date.now() + 10_000 });
    expect(all.libraries).toBe(2);
    expect(db.tables.knowledge_documents.map((k) => k.id)).toEqual(["k1"]);
  });
});

describe("KACL-10 — the sync's held-back read fails closed, and a flip during the pass leaves no mirror", () => {
  function seedSync() {
    seed();
    db.tables.knowledge_sources = [{ id: "s1", org_id: ORG, library_id: "kl-1", source_type: "library", source_id: LIB, source_name: "Operations", last_synced_at: null }];
    db.tables.knowledge_documents = [];
  }
  it("regression: a whole pass mirrors the current PDF", async () => {
    seedSync();
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.added).toBe(1);
    expect(out.errors).toEqual([]);
  });
  it("done-when 3: an errored ai_excluded read skips the pass — nothing is mirrored (it used to read as 'nothing excluded')", async () => {
    seedSync();
    db.failEq["documents|ai_excluded"] = { message: "statement timeout" };
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.added).toBe(0);
    expect(db.inserts.filter((i) => i.table === "knowledge_documents")).toEqual([]);
    expect(out.errors.join(" ")).toMatch(/held-back documents: .*not reconciled/);
  });
  it("…but a database without the column (42703) mirrors as before the feature existed", async () => {
    seedSync();
    db.failEq["documents|ai_excluded"] = { message: 'column documents.ai_excluded does not exist', code: "42703" };
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.added).toBe(1);
    expect(out.errors).toEqual([]);
  });
  it("done-when 2: a document held back WHILE the pass runs (after its first read) never keeps a mirror — the pass re-reads the flag after inserting and removes it", async () => {
    seedSync();
    db.afterFirstHeldRead = () => { db.tables.documents[0].ai_excluded = true; };
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.added).toBe(1);   // inserted on the stale read…
    expect(out.removed).toBe(1); // …and removed by the re-check
    expect((db.tables.knowledge_documents ?? []).filter((k) => k.source_document_id === DOC)).toEqual([]);
  });
});

describe("KACL-5 — the bytes door decides on the full chain, on every visibility, and fails closed behind a record", () => {
  it("done-when 1 + 2: an allow-list on a normal document's FOLDER refuses a member outside it (it was served — the guard ran for private / hidden only, on the document's own ACL)", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["discover", "read"])]) });
    expect(await bytes()).toBe(403);
    expect(db.signed).toBe(0);
    seed({ folderAcl: acl([allow("team", "T-eng", ["discover", "read"])]), teams: ["T-eng"] });
    expect(await bytes()).toBe(200);
  });
  it("done-when 2: a library-level deny binds; discover is not read; a download grant serves; a normal document with no ACL anywhere serves (regression)", async () => {
    seed({ libAcl: acl([deny("role", "Viewer", ["read", "download"])]) });
    expect(await bytes()).toBe(403);
    seed({ docVisibility: "private", docAcl: acl([allow("role", "Viewer", ["discover"])], "private") });
    expect(await bytes()).toBe(403);
    seed({ docVisibility: "private", docAcl: acl([allow("role", "Viewer", ["download"])], "private") });
    expect(await bytes()).toBe(200);
    seed();
    expect(await bytes()).toBe(200);
  });
  it("DEC-43 kept: a controller served a restricted normal document only by the tier is served and recorded; a controller of an open one is not recorded", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    expect(await bytes("u-dc")).toBe(200);
    expect(restrictedReads()).toBe(1);
    seed();
    expect(await bytes("u-dc")).toBe(200);
    expect(restrictedReads()).toBe(0);
  });
  it("DEC-7 kept: the effective owner (the cascade) pulls the bytes of a document the ACL refuses", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    db.rpc.user_is_effective_owner = (a) => a.p_uid === "u-viewer";
    expect(await bytes()).toBe(200);
  });
  it("done-when 2: a revision's NATIVE SOURCE key is judged by its document too (it resolved no record and was served on membership)", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    const src = `orgs/${ORG}/libraries/${LIB}/HSE-7__source.dwg`;
    db.tables.document_versions[0].source_file_key = src;
    const res = await downloadUrl(new NextRequest(`https://app/api/storage/download-url?path=${encodeURIComponent(src)}`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(403);
  });
  it("done-when 3: a failed lookup behind a record fails CLOSED (503, nothing signed); a key with no record behind it keeps the membership check (200)", async () => {
    seed();
    db.errors.collections = { message: "statement timeout" };
    expect(await bytes()).toBe(503);
    expect(db.signed).toBe(0);
    seed();
    db.errors.document_versions = { message: "statement timeout" };
    expect(await bytes()).toBe(503);
    seed();
    db.tables.document_versions = [];
    expect(await bytes()).toBe(200);
  });
});

describe("IEDGE-12 — the AI seam and the bytes door agree on the same document / principal pairs", () => {
  const CASES: Array<[string, Parameters<typeof seed>[0]]> = [
    ["no ACL, normal", {}],
    ["folder allow-list, outside it", { folderAcl: acl([allow("team", "T-eng", ["read"])]) }],
    ["folder allow-list, inside it", { folderAcl: acl([allow("team", "T-eng", ["read"])]), teams: ["T-eng"] }],
    ["normal document, explicit read deny on its role", { docAcl: acl([allow("org", ORG, ["read"]), deny("role", "Viewer", ["read"])]) }],
    ["library deny on a team the reader is in", { libAcl: acl([allow("role", "Viewer", ["read"]), deny("team", "T-eng", ["read"])]), teams: ["T-eng"] }],
    ["hidden, discover-only", { docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["discover"])], "hidden") }],
    ["hidden, read", { docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["read"])], "hidden") }],
    ["private, no ACL", { docVisibility: "private" }],
    ["zero-rule library ACL (a no-op drawer save)", { libAcl: acl([]) }],
  ];
  for (const [label, opts] of CASES) {
    it(label, async () => {
      seed(opts);
      const ai = await aiReads();
      seed(opts);
      const served = (await bytes()) === 200;
      expect({ ai, served }, label).toEqual({ ai, served: ai });
    });
  }
  it("…the matrix is not vacuous (both readable and refused pairs)", async () => {
    const seen = new Set<boolean>();
    for (const [, opts] of CASES) { seed(opts); seen.add(await aiReads()); }
    expect(seen).toEqual(new Set([true, false]));
  });
});

describe("DACL-6 — a zero-rule normal ACL is 'no ACL': saving the drawer without a change never blanks a library", () => {
  const P: Principal = { uid: "u-viewer", role: "Viewer" as never, roles: ["Viewer" as never], orgId: ORG, teamIds: [], isActiveMember: true };
  const ZERO = acl([]) as AccessControl;
  it("reproduction → fix: the library page's two filters and the AI seam answer as with no ACL", async () => {
    expect(evaluateAclChain([ZERO], { uid: "u-viewer", role: "Viewer" as never })).toBeNull();
    expect(canWithAclChain({ principal: P, action: "read", aclChain: [ZERO], defaultAllow: true })).toBe(true);
    expect(canDiscover({ principal: P, aclChain: [ZERO], visibility: "normal" })).toBe(true);
    seed({ libAcl: ZERO });
    expect(await aiReads()).toBe(true);
  });
  it("what still counts: any rule, or a hidden / private node (a Restrict with no grants stays controllers-only); the DB writes no index for zero rules", () => {
    expect(aclSaysSomething(ZERO)).toBe(false);
    expect(aclSaysSomething(acl([], "hidden") as AccessControl)).toBe(true);
    expect(aclSaysSomething(acl([allow("role", "Viewer", ["read"])]) as AccessControl)).toBe(true);
    expect(canReadNode({ principal: P, aclChain: [acl([], "hidden") as AccessControl], visibility: "normal" })).toBe(false);
    // a zero-rule node beside a meaningful one: the chain is evaluated exactly as before
    expect(canWithAclChain({ principal: P, action: "read", aclChain: [ZERO, acl([allow("role", "Manager", ["read"])]) as AccessControl], defaultAllow: true })).toBe(false);
    expect(buildAclIndexFromChain([ZERO], Date.now())).toBeNull();
    // publishing never default-allows (canPublishOnLibrary's null → false is unchanged)
    expect(canWithAclChain({ principal: P, action: "managePermissions", aclChain: [ZERO], defaultAllow: false })).toBe(false);
  });
});

describe("DACL-9 helper — canReadViaIndex asks the chain-resolved acl_index (the server's whole-chain view)", () => {
  const P: Principal = { uid: "u1", role: "Viewer" as never, roles: ["Viewer" as never, "Contractor" as never], orgId: ORG, teamIds: ["t1"], isActiveMember: true };
  it("deny of the action wins; allow of it or of admin grants; nothing named grants nothing; no index is unknown; controllers and owners short-circuit", () => {
    expect(canReadViaIndex(null, P)).toBeNull();
    expect(canReadViaIndex({ allow: { roles: { read: ["Viewer"] } }, deny: {} } as never, P)).toBe(true);
    expect(canReadViaIndex({ allow: { orgs: { read: [ORG] } }, deny: { teams: { read: ["t1"] } } } as never, P)).toBe(false);
    expect(canReadViaIndex({ allow: { users: { admin: ["u1"] } }, deny: {} } as never, P)).toBe(true);
    expect(canReadViaIndex({ allow: { users: { admin: ["u1"] } }, deny: { roles: { admin: ["Contractor"] } } } as never, P)).toBe(false);
    expect(canReadViaIndex({ allow: { teams: { read: ["t9"] } }, deny: {} } as never, P)).toBe(false);
    expect(canReadViaIndex({ allow: { teams: { read: ["t9"] } }, deny: {} } as never, { ...P, roles: ["DocCtrl" as never] })).toBe(true);
    expect(canReadViaIndex({ allow: { teams: { read: ["t9"] } }, deny: {} } as never, P, ["read"], "u1")).toBe(true);
  });
  it("canServeContent is canReadNode asking read or download", () => {
    const ch = [acl([allow("user", "u1", ["download"])], "private") as AccessControl];
    expect(canServeContent({ principal: P, aclChain: ch, visibility: "private" })).toBe(true);
    expect(canReadNode({ principal: P, aclChain: ch, visibility: "private" })).toBe(false);
  });
});
