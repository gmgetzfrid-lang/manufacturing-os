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
//
// Third review fix: the seam's own documents-row read throws (KACL-12 — a
// timeout is "unknown" to share serving, never "revoked"); the inherit fix's
// GRANT half is withheld until a DEC-90 ruling (DACL-9 — strictly narrower
// than the old rule); the sync's held-back read pages by keyset (KACL-10).

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
  let wantCount = false;
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
    const total = wantCount ? (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r))).length : undefined;
    return { data: rows(), error: null, ...(wantCount ? { count: total } : {}) };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": eqCols.push(args[0] as string); preds.push((r) => r[args[0] as string] === args[1]); break;
          case "neq": preds.push((r) => r[args[0] as string] !== args[1]); break;
          case "gt": preds.push((r) => r[args[0] as string] != null && String(r[args[0] as string]) > String(args[1])); break;
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
          case "select": if ((args[1] as { count?: string } | undefined)?.count === "exact") wantCount = true; break;
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
  DcLandscapeUnreadableError, DC_LANDSCAPE_PAGE, PrincipalUnreadableError, PRINCIPAL_UNREADABLE, type KnowledgePrincipal,
} from "@/lib/knowledgeAccess";
import { canReadNode, canServeContent, canDiscover, canWithAclChain, canReadViaIndex, type Principal } from "@/lib/permissions";
import { evaluateAclChain, aclSaysSomething, buildAclIndexFromChain } from "@/lib/acl";
import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import { GET as flowsBrowse } from "@/app/api/flows/browse/route";
import { GET as areaStatus } from "@/app/api/area/knowledge-status/route";
import { GET as sourcesGET, POST as sourcesPOST } from "@/app/api/knowledge/sources/route";
import { syncKnowledgeLibrarySources, syncAllKnowledgeSources } from "@/lib/knowledgeSourceSync";
import { toolByName, type ToolContext } from "@/lib/orchestrator/tools";
import { aiReadableControlledIds } from "@/lib/aiBoundaryServer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  /** A private draft (documents.is_private) and its creator (default u-dc). */
  docPrivate?: boolean; docCreator?: string;
  /** The legacy library role arrays (read_access / visible_to / write_access). */
  libReadAccess?: unknown; libVisibleTo?: unknown; libWriteAccess?: unknown;
} = {}) {
  db.tables = {
    org_members: [
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
    ],
    team_members: (opts.teams ?? []).map((t) => ({ uid: "u-viewer", team_id: t })),
    teams: [{ id: "T-eng", org_id: ORG, supervisor_user_id: null }],
    libraries: [{
      id: LIB, org_id: ORG, name: "Operations", acl: opts.libAcl ?? null, visibility: opts.libVisibility ?? "normal", owner_user_id: null, owner_team_id: null,
      ...(opts.libReadAccess !== undefined ? { read_access: opts.libReadAccess } : {}),
      ...(opts.libVisibleTo !== undefined ? { visible_to: opts.libVisibleTo } : {}),
      ...(opts.libWriteAccess !== undefined ? { write_access: opts.libWriteAccess } : {}),
    }],
    collections: [{
      id: FOLDER, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: "Incident", path_names: ["Incident"],
      acl: opts.folderAcl ?? null, visibility: opts.folderVisibility ?? "normal", owner_user_id: null, deleted_at: null,
    }],
    documents: [{
      id: DOC, org_id: ORG, library_id: LIB, collection_id: FOLDER, document_number: "HSE-7", title: "Incident procedure",
      acl: opts.docAcl ?? null, visibility: opts.docVisibility ?? "normal", acl_index: opts.docIndex ?? null,
      is_private: opts.docPrivate ?? false, scope: null, created_by: opts.docCreator ?? "u-dc", owner_user_id: null,
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
  it("done-when 2: a team_members read error yields no principal for a non-controller (a team deny is never dropped) — it THROWS PrincipalUnreadableError, never 'not a member' (second review fix); a controller still loads", async () => {
    seed({ teams: ["T-contract"] });
    db.errors.team_members = { message: "statement timeout" };
    await expect(loadPrincipal(ORG, "u-viewer")).rejects.toBeInstanceOf(PrincipalUnreadableError);
    const dc = await loadPrincipal(ORG, "u-dc");
    expect(dc).toMatchObject({ isController: true, teamIds: [] });
    // an unreadable membership row throws too; an absent one is "not a member" (null)
    seed();
    db.errors.org_members = { message: "statement timeout" };
    await expect(loadPrincipal(ORG, "u-viewer")).rejects.toMatchObject({ name: "PrincipalUnreadableError", what: "membership" });
    seed();
    expect(await loadPrincipal(ORG, "u-nobody")).toBeNull();
  });
  it("second review fix: an unreadable principal is answered 503 'try again' by the routes the review named — never 403 'Not a member' — and share serving calls it 'unknown', never a lapse", async () => {
    seed({ teams: ["T-contract"] });
    db.errors.team_members = { message: "statement timeout" };
    const browse = await flowsBrowse(new NextRequest(`https://app/api/flows/browse?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
    expect(browse.status).toBe(503);
    expect(await browse.json()).toEqual({ error: PRINCIPAL_UNREADABLE });
    const src = await sourcesGET(new NextRequest(`https://app/api/knowledge/sources?orgId=${ORG}&action=browse`, { headers: { authorization: "Bearer t" } }));
    expect(src.status).toBe(503);
    const { shareAuthority } = await import("@/lib/shareAuthorization");
    expect(await shareAuthority(ORG, "u-viewer", DOC)).toBe("unknown");
    // the landscape unreadable is 'unknown' too
    seed();
    db.errors.collections = { message: "statement timeout" };
    expect(await shareAuthority(ORG, "u-viewer", DOC)).toBe("unknown");
    // control: readable → ok; a creator who left → lapsed
    seed();
    expect(await shareAuthority(ORG, "u-viewer", DOC)).toBe("ok");
    expect(await shareAuthority(ORG, "u-gone", DOC)).toBe("lapsed");
  });
  it("third review fix: a failed read of the documents' OWN rows throws DcLandscapeUnreadableError('documents') — it read as 'no rows', so share serving said 'revoked' for a timeout — and shareAuthority calls it 'unknown'; a document id with no row is still unreadable (no throw)", async () => {
    seed();
    db.errors.documents = { message: "canceling statement due to statement timeout" };
    await expect(readableControlledDocIds(await viewer(), [DOC])).rejects.toMatchObject({ name: "DcLandscapeUnreadableError", what: "documents" });
    await expect(readableControlledDocIds(await viewer(), [DOC])).rejects.toThrow(/^The documents \(and their access rules\) could not be read: canceling statement/);
    const { shareAuthority } = await import("@/lib/shareAuthorization");
    expect(await shareAuthority(ORG, "u-viewer", DOC)).toBe("unknown");                // was "lapsed"
    // a controller is answered before any read (DEC-43), as before
    expect([...await readableControlledDocIds((await loadPrincipal(ORG, "u-dc")) as KnowledgePrincipal, [DOC])]).toEqual([DOC]);
    // control: the read answers and the row is gone → unreadable, a lapse
    seed();
    db.tables.documents = [];
    expect([...await readableControlledDocIds(await viewer(), [DOC])]).toEqual([]);
    expect(await shareAuthority(ORG, "u-viewer", DOC)).toBe("lapsed");
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
  it("done-when 4 (continuation): a project max-rows BELOW the page size — every page comes back short — still reads every folder (only an EMPTY keyset page ends the read)", async () => {
    seed();
    const extra = Array.from({ length: 1300 }, (_, i) => ({
      id: `g-${String(i).padStart(5, "0")}`, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: `G${i}`, path_names: [`G${i}`],
      acl: null, visibility: "normal", owner_user_id: null, deleted_at: null,
    }));
    const last = extra[extra.length - 1];
    last.acl = acl([deny("role", "Viewer", ["read"])]) as never;
    db.tables.collections.push(...extra);
    db.tables.documents[0].collection_id = last.id;
    db.maxRows = 500; // below DC_LANDSCAPE_PAGE: a short page that is not the last
    const l = await loadDcLandscape(ORG);
    expect(l.folders.size).toBe(extra.length + 1);
    expect(await aiReads()).toBe(false);
    last.acl = null as never;
    expect(await aiReads()).toBe(true);
  });

  it("done-when 4: the container reads page until every row is read — with a row cap below the folder count, the folder past the cap keeps its deny", async () => {
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

  it("done-when 4 (second review fix): the reads page by KEYSET — a folder deleted while the landscape is read never shifts another out of the read (the knowledge sync builds a library's folder list from it, and would remove the skipped folder's mirrors)", async () => {
    seed();
    const extra = Array.from({ length: DC_LANDSCAPE_PAGE + 300 }, (_, i) => ({
      id: `h-${String(i).padStart(5, "0")}`, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: `H${i}`, path_names: [`H${i}`],
      acl: null, visibility: "normal", owner_user_id: null, deleted_at: null,
    }));
    db.tables.collections.push(...extra);
    const all = db.tables.collections.length;
    // one folder of the FIRST window is deleted right after that window is
    // read (the 30-day trash emptied while the sync runs) — an offset read
    // would then start its second window one row late and skip
    // extra[DC_LANDSCAPE_PAGE - 1]
    const folders = db.tables.collections;
    const victim = extra[10].id;
    let pages = 0;
    const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
    const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
    const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation(((t: string) => {
      if (t === "collections" && ++pages === 2) {
        const i = folders.findIndex((r) => r.id === victim);
        if (i >= 0) folders.splice(i, 1);
      }
      return realFrom(t);
    }) as typeof supabaseAdmin.from);
    try {
      const l = await loadDcLandscape(ORG);
      expect(pages).toBeGreaterThanOrEqual(2);
      // every folder is in the landscape (the victim was read before it went) — none is skipped
      expect(l.folders.size).toBe(all);
      expect(l.folders.has(extra[DC_LANDSCAPE_PAGE - 1].id)).toBe(true);
      expect(l.folders.has(extra[DC_LANDSCAPE_PAGE].id)).toBe(true);
      expect(l.folders.has(extra[extra.length - 1].id)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // and the read asks no count and no offset window: a keyset bound and a limit
    const k = readFileSync(join(process.cwd(), "lib/knowledgeAccess.ts"), "utf8");
    const body = k.slice(k.indexOf("async function readAllPages"), k.indexOf("type LandscapeFolder"));
    expect(body).toMatch(/q = q\.gt\("id", lastId\)/);
    expect(body).toMatch(/\.limit\(DC_LANDSCAPE_PAGE\)/);
    expect(body).not.toMatch(/\.range\(/);
    expect(body).not.toMatch(/count: "exact"/);
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
  it("third review fix: the held-back read pages by KEYSET until an empty page — under a project max-rows below the page size, the held-back documents past the first page are still held back and none becomes a pending mirror (the offset loop stopped at the first short page)", async () => {
    seedSync();
    // 600 held-back PDFs, stored newest-id first so the (unordered) source
    // enumeration meets the ones a 500-row first page of the id-ordered
    // held-back read would miss
    const held = Array.from({ length: 600 }, (_, i) => `h-${String(599 - i).padStart(4, "0")}`).map((id) => ({
      ...db.tables.documents[0], id, document_number: id.toUpperCase(), current_version_id: `v-${id}`, ai_excluded: true,
    }));
    db.tables.documents.push(...held);
    db.tables.document_versions.push(...held.map((d) => ({
      id: `v-${d.id}`, record_id: d.id, file_url: `orgs/${ORG}/libraries/${LIB}/${d.id}.pdf`, file_type: "application/pdf",
      archived_at: null, archive_id: null, revision_label: "A", size: 10,
    })));
    db.maxRows = 500; // below HELD_BACK_PAGE (1000): every page comes back short
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.errors).toEqual([]);
    const insertedSources = db.inserts.filter((i) => i.table === "knowledge_documents")
      .flatMap((i) => (Array.isArray(i.row) ? i.row : [i.row]) as Row[]).map((r) => r.source_document_id);
    expect(insertedSources).toEqual([DOC]);   // the offset read inserted h-0500…h-0599 as pending mirrors, then removed them
    expect(out.added).toBe(1);
    expect(out.removed).toBe(0);
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
    // review fix: the private-draft rule is in the one predicate, so both doors apply it
    ["another member's private draft", { docPrivate: true }],
    ["the reader's own private draft", { docPrivate: true, docCreator: "u-viewer" }],
    // review fix: a legacy read list binds at both doors (one library check)
    ["legacy read_access ['HR'] with a zero-rule ACL, a Viewer", { libAcl: acl([]), libReadAccess: ["HR"], libVisibleTo: [] }],
    ["legacy read_access ['Viewer'] with a zero-rule ACL", { libAcl: acl([]), libReadAccess: ["Viewer"], libVisibleTo: [] }],
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

describe("KACL-9 / KACL-10 — the AI boundary at every door that hands the model document content", () => {
  function seedMirror(docPatch: Row = {}) {
    seed();
    Object.assign(db.tables.documents[0], docPatch);
    db.tables.knowledge_documents = [
      { id: "k1", org_id: ORG, library_id: "kl-1", source_document_id: DOC },
      { id: "k3", org_id: ORG, library_id: "kl-1", source_document_id: null },
    ];
    db.tables.assets = [{ id: "a1", org_id: ORG, tag: "E-101", archived: false }];
    db.tables.entity_mentions = [
      { org_id: ORG, asset_id: "a1", page: 2, context_snippet: "E-101 relief case", mention_count: 3, knowledge_document_id: "k1", document_id: null, knowledge_documents: { name: "HSE-7" } },
      { org_id: ORG, asset_id: "a1", page: 1, context_snippet: "E-101 direct", mention_count: 2, knowledge_document_id: null, document_id: DOC, knowledge_documents: null },
      { org_id: ORG, asset_id: "a1", page: 1, context_snippet: "E-101 in the note", mention_count: 1, knowledge_document_id: "k3", document_id: null, knowledge_documents: { name: "Site note" } },
    ];
    db.rpc.graph_ask = () => [
      { knowledge_document_id: "k1", document_name: "HSE-7", page: 2, snippet: "the relief case" },
      { knowledge_document_id: "k3", document_name: "Site note", page: 1, snippet: "relief valve replaced" },
    ];
  }
  async function ctx(): Promise<ToolContext> {
    const p = await viewer();
    return { orgId: ORG, userId: p.uid, role: p.role, principal: p, actorName: "Pat", approved: new Set() };
  }
  const passages = async () => ((await toolByName("search_documents")!.run({ query: "relief" }, await ctx())).data as { passages: Array<{ document: string }> }).passages.map((x) => x.document).sort();
  const mentions = async () => ((await toolByName("equipment_mentions")!.run({ tag: "E-101" }, await ctx())).data as { mentions: Array<{ evidence: string }> }).mentions.map((x) => x.evidence).sort();

  it("aiReadableControlledIds is lib/aiBoundary aiReadability over the documents as they are now; a failed read admits none", async () => {
    seed();
    expect([...await aiReadableControlledIds(ORG, [DOC])]).toEqual([DOC]);
    for (const patch of [{ ai_excluded: true }, { status: "Superseded" }, { status: "Void" }, { archived_at: "2026-10-01" }, { current_version_id: null }]) {
      seed();
      Object.assign(db.tables.documents[0], patch);
      expect([...await aiReadableControlledIds(ORG, [DOC])], JSON.stringify(patch)).toEqual([]);
    }
    seed();
    expect([...await aiReadableControlledIds("another-org", [DOC])]).toEqual([]);
    db.errors.documents = { message: "timeout" };
    expect([...await aiReadableControlledIds(ORG, [DOC])]).toEqual([]);
  });
  it("orchestrator search_documents: a mirror of a held-back or superseded document gives no passage, whatever a racing sync left (it was a list capped at 2000, open on error)", async () => {
    seedMirror();
    expect(await passages()).toEqual(["HSE-7", "Site note"]);
    seedMirror({ ai_excluded: true });
    expect(await passages()).toEqual(["Site note"]);
    seedMirror({ status: "Superseded" });
    expect(await passages()).toEqual(["Site note"]);
  });
  it("orchestrator equipment_mentions: the proving sentence of a held-back document (mirror or direct) is not read back (it applied no AI boundary)", async () => {
    seedMirror();
    expect(await mentions()).toEqual(["E-101 direct", "E-101 in the note", "E-101 relief case"]);
    seedMirror({ ai_excluded: true });
    expect(await mentions()).toEqual(["E-101 in the note"]);
  });
  it("every door that reads mirrors for a model asks the boundary (source pins: ask, sync, flows/browse via aiReadability; the orchestrator's hop, drawing and locate via aiReadableControlledIds)", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("app/api/knowledge/ask/route.ts")).toMatch(/aiReadability\(/);
    expect(src("lib/knowledgeSourceSync.ts")).toMatch(/aiReadability\(/);
    expect(src("app/api/flows/browse/route.ts")).toMatch(/aiReadability\(/);
    const tools = src("lib/orchestrator/tools.ts");
    const hop = tools.slice(tools.indexOf("async function unreadableMirrors"), tools.indexOf("/** KACL-9: which of these controlled documents"));
    expect(hop).toMatch(/aiReadableControlledIds\(ctx\.orgId, sources\)/);
    expect(tools).not.toMatch(/\.eq\("ai_excluded", true\)\.limit\(2000\)/);
    expect(src("app/api/knowledge/drawing/route.ts")).toMatch(/aiReadableControlledIds\(orgId, sources\)/);
    const locate = src("app/api/knowledge/locate/route.ts");
    expect((locate.match(/aiReadableControlledIds\(orgId, /g) ?? []).length).toBe(2);
    expect(src("lib/aiBoundaryServer.ts")).toMatch(/const verdict = aiReadability\(/);
  });
});

describe("DACL-9 / DACL-10 — the explorer's chains and the one library check (lib/libraryAccess)", () => {
  const V: Principal = { uid: "u-v", role: "Viewer" as never, roles: ["Viewer" as never], orgId: ORG, teamIds: [], isActiveMember: true };
  const A = acl([allow("team", "T-a", ["discover", "read"])], "private") as AccessControl;
  // Folder A (private, granted to team T-a only) → folder B (normal, inherits,
  // no ACL of its own) → a document. The viewer is not in T-a, so RLS never
  // sends them A's row: the page's folderMap holds B alone.
  const folderB = { id: "B", pathIds: ["A"], visibility: "normal" as const, aclIndex: buildAclIndexFromChain([A], Date.now()) ?? undefined };
  const docInB = { collectionId: "B", aclIndex: buildAclIndexFromChain([A], Date.now()) ?? undefined };
  const onlyB = new Map([["B", folderB]]);

  it("reproduction → fix: 'hidden ancestor, visible descendant' — the descendant folder and its document are NOT shown (the truncated chain allowed both)", async () => {
    const { folderAclChain, docAclChain, explorerFolderVisible, explorerDocReadable } = await import("@/lib/libraryAccess");
    // the truncated chain is empty: today's evaluation defaulted to allow
    expect(folderAclChain(undefined, folderB, onlyB)).toEqual({ chain: [], complete: false });
    expect(canWithAclChain({ principal: V, action: "read", aclChain: docAclChain(undefined, docInB, onlyB).chain, defaultAllow: true })).toBe(true);
    // the fix: the row's chain-resolved acl_index decides
    expect(explorerFolderVisible(V, undefined, folderB, onlyB, null)).toBe(false);
    expect(explorerDocReadable(V, undefined, docInB, onlyB, null)).toBe(false);
    // a member of T-a, or a controller, or the owner, still sees both (regression)
    const inA = { ...V, teamIds: ["T-a"] };
    expect(explorerFolderVisible(inA, undefined, folderB, onlyB, null)).toBe(true);
    expect(explorerDocReadable(inA, undefined, docInB, onlyB, null)).toBe(true);
    expect(explorerDocReadable({ ...V, roles: ["DocCtrl" as never] }, undefined, docInB, onlyB, null)).toBe(true);
    expect(explorerDocReadable(V, undefined, docInB, onlyB, "u-v")).toBe(true);
  });
  it("a complete chain is evaluated exactly as before; a row with no index under an unresolved ancestor keeps today's evaluation (no new lock-out)", async () => {
    const { explorerDocReadable, explorerFolderVisible } = await import("@/lib/libraryAccess");
    const both = new Map<string, { id: string; pathIds: string[]; acl?: AccessControl; visibility: "normal" | "private" }>([
      ["A", { id: "A", pathIds: [], acl: A, visibility: "private" }],
      ["B", { id: "B", pathIds: ["A"], visibility: "normal" }],
    ]);
    expect(explorerDocReadable(V, undefined, { collectionId: "B" }, both, null)).toBe(false);
    expect(explorerFolderVisible(V, undefined, both.get("B")!, both, null)).toBe(false);
    expect(explorerDocReadable(V, undefined, { collectionId: "B" }, onlyB, null)).toBe(true);
  });
  it("DACL-9 done-when 2: the document chain carries the library's ACL once", async () => {
    const { docAclChain } = await import("@/lib/libraryAccess");
    const lib = acl([allow("role", "Viewer", ["read"])], "normal", false) as AccessControl;
    const f = { id: "F", pathIds: [], acl: acl([allow("role", "Manager", ["read"])]) as AccessControl };
    const { chain } = docAclChain(lib, { collectionId: "F" }, new Map([["F", f]]));
    expect(chain.filter((c) => c === lib)).toHaveLength(1);
    expect(chain).toEqual([lib, f.acl]);
    expect(docAclChain(lib, { collectionId: null }, new Map()).chain).toEqual([lib]);
    // and the page's own buildDocChain no longer pushes it twice
    const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    const body = page.slice(page.indexOf("const buildDocChain = useCallback("), page.indexOf("const explorerLibraryAcl"));
    expect((body.match(/library\?\.acl \? \[library\.acl\]|if \(library\?\.acl\) chain\.push\(library\.acl\)/g) ?? []).length).toBe(1);
  });
  it("DACL-10: a legacy library whose ACL says nothing while its read list is restricted is evaluated under the ACL that list stands for — a direct URL no longer lists its documents to a role the home page hides it from", async () => {
    const { effectiveLibraryAcl, libraryReadsByRole, explorerDocReadable } = await import("@/lib/libraryAccess");
    const legacy = { readAccess: ["HR", "Admin"] as never, visibleTo: [] as never, acl: null, visibility: "normal" as const };
    expect(libraryReadsByRole(legacy, "Maintenance" as never)).toBe(false);
    const eff = effectiveLibraryAcl(legacy);
    const M: Principal = { ...V, role: "Maintenance" as never, roles: ["Maintenance" as never] };
    expect(explorerDocReadable(M, eff, { collectionId: null }, new Map(), null)).toBe(false);          // was true (no ACL → default allow)
    expect(explorerDocReadable({ ...M, role: "HR" as never, roles: ["HR" as never] }, eff, { collectionId: null }, new Map(), null)).toBe(true);
    // a deeper grant still merges in (a folder shared with Maintenance)
    const shared = { id: "S", pathIds: [], acl: acl([allow("role", "Maintenance", ["discover", "read"])]) as AccessControl };
    expect(explorerDocReadable(M, eff, { collectionId: "S" }, new Map([["S", shared]]), null)).toBe(true);
    // "ALL", or a library whose ACL says something, is unchanged
    expect(effectiveLibraryAcl({ readAccess: "ALL", acl: null })).toBeUndefined();
    const wizard = acl([allow("role", "HR", ["read"])]) as AccessControl;
    expect(effectiveLibraryAcl({ readAccess: ["HR"] as never, acl: wizard })).toBe(wizard);
    expect(effectiveLibraryAcl({ readAccess: ["HR"] as never, acl: acl([]) as AccessControl })?.rules).toHaveLength(1);
  });
  it("DACL-10 done-when 2 + 3 / DACL-6 done-when 2: one library check on both pages; the library page says 'no access' / 'restricted' instead of an empty folder", () => {
    const home = readFileSync(join(process.cwd(), "app/(protected)/documents/page.tsx"), "utf8");
    const lib = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    expect(home).not.toMatch(/function computeCanRead/);
    expect(home).toMatch(/libraryReadsByRole\(normalized, activeRole, roles\)/);
    // review fix: the library page decides "no access" from the explorer's
    // own evaluation of the effective library rung (lib/libraryAccess
    // explorerLibraryVisible), and waits for the role and the teams first
    expect(lib).toMatch(/const libraryReadable = isController \|\| isLibraryOwner \|\| explorerLibraryVisible\(principal, library\);/);
    expect(lib).toMatch(/const accessResolved = !roleLoading && \(activeRole === null \|\| !uid \|\| teamIdsFor === uid\);/);
    expect(lib).toMatch(/filteredFolders\.length === 0 && !accessResolved \? \(/);
    expect(lib).toContain("You don't have access to this library");
    expect(lib).toMatch(/restricted by their access rules\. To request access, ask the library's owner or a document controller\./);
    expect(lib).toMatch(/\(!libraryReadable \|\| restrictedHere > 0\) \? \(/);
  });
});

describe("VFY-7 — the short link's resolver: punctuation-forgiving at the query, a chooser for two exact matches", () => {
  it("source pins: the normalized number itself (an anchored ~* pattern) as the second candidate read, exact normalized matches only, a chooser for more than one, never rows[0]", () => {
    const home = readFileSync(join(process.cwd(), "app/(protected)/documents/page.tsx"), "utf8");
    // the second candidate read matches the normalized number itself (an
    // anchored ~* pattern, built by lib/docNumberMatch shortLinkExactMatches),
    // never a loose in-order window; both reads always run (second review fix)
    expect(home).toMatch(/hits = await shortLinkExactMatches<DocumentRow>\(raw, \{/);
    expect(home).toMatch(/\.regexIMatch\("document_number", pattern\)/);
    expect(home).toMatch(/if \(error\) throw new Error\(error\.message\);/);
    expect(home).not.toMatch(/exact\.size === 0/);
    expect(home).not.toMatch(/\.ilike\("document_number", `%\$\{norm/);
    const lib = readFileSync(join(process.cwd(), "lib/docNumberMatch.ts"), "utf8");
    expect(lib).toMatch(/if \(normalizeDocNumber\(r\.document_number\) === norm\) exact\.set\(r\.id, r\);/);
    expect(lib).toMatch(/if \(norm\.length >= 2\) take\(await reads\.normalized\(normalizedNumberPattern\(norm\)\)\);/);
    expect(home).toMatch(/else if \(hits\.length > 1\) \{[\s\S]*?setShortLinkChoices\(\{ raw, rows: hits \}\);/);
    expect(home).toContain("data-short-link-chooser");
    expect(home).not.toMatch(/\?\? \(rows \?\? \[\]\)\[0\]/);
  });
});

// ── I-12 review fixes ──────────────────────────────────────────────────────
describe("DACL-10 (review fix) — one library check at the AI seam and the bytes door: a legacy read list binds", () => {
  const HR = (p: KnowledgePrincipal): KnowledgePrincipal => ({ ...p, role: "HR" as never, roles: ["HR" as never] });
  it("reproduction → fix: read_access ['HR'], visible_to [] and a zero-rule ACL — a Viewer's AI does not read it and is not offered the library; HR's does", async () => {
    seed({ libAcl: acl([]), libReadAccess: ["HR"], libVisibleTo: [] });
    expect(await aiReads()).toBe(false);                         // was true: a zero-rule ACL said nothing
    const l = await loadDcLandscape(ORG);
    expect(containerReadable("library", LIB, await viewer(), l)).toBe(false);
    expect(containerReadable("folder", FOLDER, await viewer(), l)).toBe(false);
    const hr = HR(await viewer());
    expect([...await readableControlledDocIds(hr, [DOC])]).toEqual([DOC]);
    expect(containerReadable("library", LIB, hr, l)).toBe(true);
    // the bytes door asks the same rung
    expect(await bytes()).toBe(403);
    db.tables.org_members[0] = { ...db.tables.org_members[0], role: "HR", roles: ["HR"] };
    expect(await bytes()).toBe(200);
  });
  it("an ACL NULL legacy row binds the same way; \"ALL\", a NULL read list and a library whose ACL says something are unchanged", async () => {
    seed({ libReadAccess: ["HR"] });
    expect(await aiReads()).toBe(false);
    seed({ libReadAccess: "ALL", libAcl: acl([]) });
    expect(await aiReads()).toBe(true);
    seed({ libReadAccess: null });
    expect(await aiReads()).toBe(true);
    seed({ libReadAccess: ["HR"], libAcl: acl([allow("role", "Viewer", ["read"])]) });
    expect(await aiReads()).toBe(true);
  });
  it("a write role outside the read list reads, as the library wizard lets it (LibraryWizard: write roles get read)", async () => {
    seed({ libAcl: acl([]), libReadAccess: ["Engineer-1"], libVisibleTo: [], libWriteAccess: ["Viewer"] });
    expect(await aiReads()).toBe(true);
    expect(await bytes()).toBe(200);
    const { legacyLibraryAcl, effectiveLibraryAclFromRow } = await import("@/lib/libraryAccess");
    const synthesized = legacyLibraryAcl({ readAccess: ["Engineer-1"] as never, writeAccess: ["Drafter"] as never, adminAccess: ["Admin"] as never, acl: null });
    expect(synthesized?.rules.map((r) => (r.subject as { id: string }).id)).toEqual(["Engineer-1", "Drafter", "Admin"]);
    expect(synthesized?.rules.every((r) => r.actions.join() === "discover,read,download")).toBe(true);
    expect(effectiveLibraryAclFromRow({ acl: null, read_access: "ALL", write_access: ["Drafter"] })).toBeUndefined();
  });
  it("the seam and the bytes door take the rung from lib/libraryAccess (source pins)", () => {
    const k = readFileSync(join(process.cwd(), "lib/knowledgeAccess.ts"), "utf8");
    expect(k).toMatch(/acl: effectiveLibraryAclFromRow\(l\) \?\? null,/);
    const d = readFileSync(join(process.cwd(), "lib/docFileServer.ts"), "utf8");
    expect(d).toMatch(/\.from\("libraries"\)\.select\(`id, \$\{LIBRARY_RUNG_COLUMNS\}`\)/);
    expect(d).toMatch(/return \[effectiveLibraryAclFromRow\(lib as Record<string, unknown>\), \.\.\.folders\];/);
  });
});

describe("DACL-10 done-when 2 (review fix) — the library page's 'no access' state is the explorer's own evaluation", () => {
  const V: Principal = { uid: "u-v", role: "Viewer" as never, roles: ["Viewer" as never], orgId: ORG, teamIds: [], isActiveMember: true };
  it("a team or user grant on the library counts; the legacy arrays bind through the effective rung; no principal sees nothing", async () => {
    const { explorerLibraryVisible } = await import("@/lib/libraryAccess");
    const teamGrant = acl([allow("role", "HR", ["discover", "read"]), allow("team", "T-eng", ["discover", "read"])]) as AccessControl;
    expect(explorerLibraryVisible(V, { readAccess: ["HR"] as never, acl: teamGrant })).toBe(false);
    expect(explorerLibraryVisible({ ...V, teamIds: ["T-eng"] }, { readAccess: ["HR"] as never, acl: teamGrant })).toBe(true); // the role arrays alone said no
    const userGrant = acl([allow("user", "u-v", ["discover"])]) as AccessControl;
    expect(explorerLibraryVisible(V, { readAccess: ["HR"] as never, acl: userGrant })).toBe(true);
    expect(explorerLibraryVisible(V, { readAccess: ["HR"] as never, acl: null })).toBe(false);
    expect(explorerLibraryVisible(V, { readAccess: "ALL", acl: null })).toBe(true);
    expect(explorerLibraryVisible(V, { readAccess: ["HR"] as never, acl: null, ownerUserId: "u-v" })).toBe(true);
    expect(explorerLibraryVisible({ ...V, roles: ["DocCtrl" as never] }, { readAccess: ["HR"] as never, acl: null })).toBe(true);
    expect(explorerLibraryVisible(null, { readAccess: "ALL", acl: null })).toBe(false);
  });
});

describe("DACL-9 (review fix) — inherit:false resets on the node's OWN step only", () => {
  const ctxX = { uid: "u1", role: "Viewer" as never, roles: ["Viewer" as never], orgId: ORG, teamIds: ["T-x"] };
  const folder = acl([allow("org", ORG, ["read"]), deny("team", "T-x", ["read"])], "normal", false) as AccessControl;
  const docOwn = acl([allow("team", "T-x", ["read"])]) as AccessControl;
  it("reproduction → fix: a folder with inherit:false and [deny team X read] above a document carrying its own ACL — the deny binds (it was dropped and the document's allow won)", () => {
    const lib = acl([allow("org", ORG, ["read"])]) as AccessControl;
    const decision = evaluateAclChain([lib, folder, docOwn], ctxX);
    expect(decision?.can("read")).toBe(false);
    // the index is built the same way
    const idx = buildAclIndexFromChain([lib, folder, docOwn], Date.now());
    expect(idx?.deny.teams?.read).toContain("T-x");
    expect(canReadViaIndex(idx, { ...ctxX, isActiveMember: true } as Principal)).toBe(false);
  });
  it("a node's own inherit:false still clears its ancestors' rules (a library deny above it no longer applies)", () => {
    const lib = acl([deny("team", "T-x", ["read"])]) as AccessControl;
    const restart = acl([allow("team", "T-x", ["read"])], "normal", false) as AccessControl;
    expect(evaluateAclChain([lib, restart], ctxX)?.can("read")).toBe(true);
    expect(buildAclIndexFromChain([lib, restart], Date.now())?.deny.teams?.read ?? []).toEqual([]);
  });
  it("third review fix — the WIDENING half is withheld until the DEC-90 ruling: the node below a non-inheriting one still drops that node's GRANTS (as the old rule did), in the app and in the index alike", () => {
    const lib = acl([deny("team", "T-x", ["read"])]) as AccessControl;
    const restart = acl([allow("team", "T-x", ["read"])], "normal", false) as AccessControl;
    const below = acl([]) as AccessControl;
    expect(evaluateAclChain([lib, restart, below], ctxX)?.can("read")).toBe(false);                     // as before the fix
    expect(buildAclIndexFromChain([lib, restart, below], Date.now())?.allow.teams?.read ?? []).toEqual([]);
    // …while the same node's DENIES and visibility now carry (the narrowing half)
    const restartDeny = acl([allow("org", ORG, ["read"]), deny("team", "T-x", ["read"])], "private", false) as AccessControl;
    const docOwn = acl([allow("team", "T-x", ["discover", "read"])]) as AccessControl;
    expect(evaluateAclChain([lib, restartDeny, docOwn], ctxX)?.can("read")).toBe(false);
    expect(evaluateAclChain([lib, restartDeny, { inherit: true, rules: [] } as AccessControl], ctxX)?.visibility).toBe("private");
    const idx = buildAclIndexFromChain([lib, restartDeny, docOwn], Date.now());
    expect(idx?.deny.teams?.read).toEqual(["T-x"]);
    expect(idx?.allow.orgs?.read ?? []).toEqual([]);                                                   // the org grant is withheld below
    expect(idx?.allow.teams?.read).toEqual(["T-x"]);                                                   // the document's own grant stands (the deny wins)
  });
  it("third review fix — strictly narrower than the old rule: on every chain of up to three nodes over these rules, a reader the new evaluation admits the old one admitted too", () => {
    const oldEval = (chain: AccessControl[]) => {
      // the rule before the DACL-9 fix: reset on the node's own flag AND on the previous node's
      let merged: unknown[] = []; let inherit = true;
      for (const a of chain) {
        const own = a.inherit !== false;
        if (!inherit || !own) merged = [];
        merged = merged.concat(a.rules ?? []);
        inherit = own;
      }
      return evaluateAclChain([{ inherit: true, visibility: "normal", rules: merged } as AccessControl], ctxX)?.can("read") ?? true;
    };
    const nodes: AccessControl[] = [];
    for (const inherit of [true, false]) {
      for (const rules of [[], [allow("team", "T-x", ["read"])], [deny("team", "T-x", ["read"])], [allow("org", ORG, ["read"]), deny("team", "T-x", ["read"])]]) {
        nodes.push(acl(rules, "normal", inherit) as AccessControl);
      }
    }
    let compared = 0;
    for (const a of nodes) for (const b of nodes) for (const c of nodes) {
      const chain = [a, b, c];
      if (!chain.some((n) => (n.rules ?? []).length > 0)) continue;
      const now = evaluateAclChain(chain, ctxX)?.can("read") ?? true;
      if (now) expect(oldEval(chain)).toBe(true);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(400);
  });
});

describe("KACL-5 / DEC-43 (review fix) — the bytes door answers a controller before the chain", () => {
  it("a broken chain refuses a member (409) but serves a controller, recorded as chain_unverified (it was a 409 for the controller too)", async () => {
    seed();
    db.tables.documents[0].collection_id = "99999999-9999-4999-8999-999999999999";
    expect(await bytes()).toBe(409);
    expect(await bytes("u-dc")).toBe(200);
    const rec = db.inserts.filter((i) => i.table === "audit_logs" && (i.row as Row).action === "CONTROLLER_RESTRICTED_READ");
    expect(rec).toHaveLength(1);
    expect(((rec[0].row as Row).details as Row).chain_unverified).toMatch(/folder chain is broken/);
  });
  it("a failed folder read (transient) is 503 for a member and served + recorded for a controller", async () => {
    seed();
    db.errors.collections = { message: "statement timeout" };
    expect(await bytes()).toBe(503);
    expect(await bytes("u-dc")).toBe(200);
    expect(restrictedReads()).toBe(1);
  });
  it("a team_members read error is 503 for a member and still serves a controller (teams decide nothing for the tier)", async () => {
    seed();
    db.errors.team_members = { message: "statement timeout" };
    expect(await bytes()).toBe(503);
    expect(await bytes("u-dc")).toBe(200);
  });
  it("…and an explicit download deny still binds a controller (the deny reads its own membership)", async () => {
    seed({ docIndex: { deny: { roles: { download: ["DocCtrl"] } } } });
    db.tables.documents[0].collection_id = "99999999-9999-4999-8999-999999999999";
    expect(await bytes("u-dc")).toBe(403);
  });
});

describe("IEDGE-12 (review fix) — the private-draft rule is in the one predicate", () => {
  it("another member's private draft is refused by the AI seam AND the bytes door; the creator and a controller (recorded) are served; the owner cascade does not open another creator's draft", async () => {
    seed({ docPrivate: true });
    expect(await aiReads()).toBe(false);
    expect(await bytes()).toBe(403);                               // was 200: the bytes door never read is_private
    db.rpc.user_is_effective_owner = (a) => a.p_uid === "u-viewer";
    expect(await bytes()).toBe(403);
    seed({ docPrivate: true, docCreator: "u-viewer" });
    expect(await aiReads()).toBe(true);
    expect(await bytes()).toBe(200);
    seed({ docPrivate: true, docCreator: "u-other" });
    expect(await bytes("u-dc")).toBe(200);
    expect(restrictedReads()).toBe(1);
  });
  it("canReadNode: a private draft is its creator's alone, whatever the chain grants", () => {
    const P: Principal = { uid: "u1", role: "Viewer" as never, roles: ["Viewer" as never], orgId: ORG, teamIds: [], isActiveMember: true };
    const open = [acl([allow("org", ORG, ["read", "download"])]) as AccessControl];
    expect(canReadNode({ principal: P, aclChain: open, privateDraft: { createdBy: "u2" } })).toBe(false);
    expect(canReadNode({ principal: P, aclChain: open, privateDraft: { createdBy: "u2" }, effectiveOwnerUserId: "u1" })).toBe(false);
    expect(canReadNode({ principal: P, aclChain: open, privateDraft: { createdBy: "u1" } })).toBe(true);
    expect(canReadNode({ principal: P, aclChain: open, privateDraft: null })).toBe(true);
    expect(canServeContent({ principal: { ...P, roles: ["Admin" as never] }, aclChain: [], privateDraft: { createdBy: "u2" } })).toBe(true);
  });
});

describe("KACL-5 (review fix) — an allow-list on a normal chain binds the bytes door: the flows it changes, pinned", () => {
  // Work-pack printing (lib/docPack resolveToHttpUrl) and the viewer opened
  // from global search fetch through this door. A reader inside the
  // allow-list is served — a pack they print still carries the sheet; a
  // reader outside it is refused (403), which docPack records as the sheet
  // left out with "the file could not be fetched (… 403)" — see KACL-5.
  it("a Planner inside a role-restricted library's allow-list is served; one outside it is refused", async () => {
    seed({ libAcl: acl([allow("role", "Planner", ["discover", "read", "download"])]) });
    expect(await bytes()).toBe(403);
    db.tables.org_members[0] = { ...db.tables.org_members[0], role: "Planner", roles: ["Planner"] };
    expect(await bytes()).toBe(200);
    // the same reader through a legacy read list
    seed({ libReadAccess: ["Planner"] });
    db.tables.org_members[0] = { ...db.tables.org_members[0], role: "Planner", roles: ["Planner"] };
    expect(await bytes()).toBe(200);
  });
});
