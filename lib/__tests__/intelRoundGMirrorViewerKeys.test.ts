// intelligence Round G, package I-29 KNOWLEDGE VIEWER KEYS AND PICKER READS.
//
//   KACL-5 criterion 4 / KACL-7 criterion 3 — a SOURCE-LINKED knowledge
//     mirror never hands the browser `knowledge_documents.file_key`: the
//     library list does not select it for mirror rows, and the viewer opens a
//     mirror's page through /api/knowledge/mirror-url, which decides through
//     the bytes door's own handler (the I-12 read predicate) and answers a
//     short-lived signed URL — never the key. A mirror whose source the
//     caller may not read yields no key, no URL and no bytes; every reader
//     who opened a mirror before opens exactly what they opened before (the
//     same door decided the same key), except a bound key from before the
//     orgs/ prefix, now decided by the source's read predicate (the intended
//     narrowing); a fault fails closed and says so. The browser remembers no
//     URL by document id: a re-pointed mirror opens its new revision.
//   KACL-9 residual — /api/flows/browse and /api/area/knowledge-status read
//     the held-back flag CHECKED: an errored read withholds (503), a missing
//     column holds nothing back (as the knowledge sync reads it).
//
// Everything runs the REAL code (the two routes, /api/storage/download-url,
// lib/permissions, lib/knowledgeAccess, lib/docFileServer, lib/knowledge)
// over an in-memory, filter- and column-aware PostgREST stand-in; only the
// service-role / browser clients and the R2 presigner are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string; code?: string }>,
  /** "table|column": an .eq(column, …) read of `table` errors with this. */
  failEq: {} as Record<string, { message: string; code?: string }>,
  /** table → columns that do not exist (a select naming one errors 42703). */
  missingColumns: {} as Record<string, string[]>,
  maxRows: 100000,
  rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  /** Every select issued: table, columns, filters. */
  selects: [] as Array<{ table: string; columns: string; filters: string[] }>,
  user: null as null | { id: string; email?: string },
  signed: 0,
  /** The storage key of every URL the presigner signed, in order. */
  signedKeys: [] as string[],
}));

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  const filters: string[] = [];
  let cap: number | null = null;
  let op: "select" | "insert" = "select";
  let columns = "*";
  let payload: unknown = null;
  const eqCols: string[] = [];
  const cmp = (a: unknown, b: unknown) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
  const project = (r: Row): Row => {
    if (columns.trim() === "*") return r;
    const out: Row = {};
    for (const c of columns.split(",").map((x) => x.trim()).filter(Boolean)) if (c in r) out[c] = r[c];
    return out;
  };
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
    if (cap !== null) out = out.slice(0, cap);
    return out.slice(0, db.maxRows).map(project);
  };
  const failed = () => {
    if (db.errors[table]) return db.errors[table];
    const eqFail = eqCols.map((c) => db.failEq[`${table}|${c}`]).find(Boolean);
    if (eqFail) return eqFail;
    const missing = db.missingColumns[table] ?? [];
    const named = columns.split(",").map((x) => x.trim());
    const gone = named.find((c) => missing.includes(c));
    if (gone) return { message: `column ${table}.${gone} does not exist`, code: "42703" };
    return null;
  };
  const result = () => {
    const err = failed();
    if (op === "select") db.selects.push({ table, columns, filters: [...filters] });
    if (err) return { data: null, error: err };
    if (op === "insert") {
      db.inserts.push({ table, row: payload });
      return { data: null, error: null };
    }
    return { data: rows(), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": eqCols.push(args[0] as string); filters.push(`eq:${String(args[0])}`); preds.push((r) => r[args[0] as string] === args[1]); break;
          case "gt": filters.push(`gt:${String(args[0])}`); preds.push((r) => r[args[0] as string] != null && String(r[args[0] as string]) > String(args[1])); break;
          case "in": filters.push(`in:${String(args[0])}`); preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); break;
          case "is": filters.push(`is:${String(args[0])}`); preds.push((r) => (args[1] === null ? r[args[0] as string] == null : r[args[0] as string] === args[1])); break;
          case "not": {
            const [col, o, val] = args as [string, string, unknown];
            filters.push(`not:${col}`);
            if (o === "is" && val === null) preds.push((r) => r[col] != null);
            break;
          }
          case "order": orders.push({ col: args[0] as string, asc: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false }); break;
          case "limit": cap = args[0] as number; break;
          case "range": break;
          case "select": columns = (args[0] as string | undefined) ?? "*"; break;
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
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input?: { Key?: string } }) => {
    db.signed += 1;
    db.signedKeys.push(String(command?.input?.Key ?? ""));
    return "https://signed.example/get";
  }),
}));

import { GET as mirrorUrl } from "@/app/api/knowledge/mirror-url/route";
import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import { GET as flowsBrowse } from "@/app/api/flows/browse/route";
import { GET as areaStatus } from "@/app/api/area/knowledge-status/route";
import {
  listKnowledgeDocuments, getKnowledgeMirrorUrl, KnowledgeMirrorRestrictedError, MIRROR_LIST_COLUMN_TIERS,
} from "@/lib/knowledge";
import {
  MIRROR_SOURCE_RESTRICTED, MIRROR_ACCESS_UNVERIFIED, MIRROR_UNBOUND, MIRROR_KEY_OUTSIDE_WORKSPACE,
  MIRROR_NOT_FOUND, MIRROR_IS_UPLOAD, MIRROR_KEY_INVALID,
} from "@/lib/knowledgeMirrorAccess";
import { readHeldBackIds, HELD_BACK_UNREADABLE, HELD_BACK_IDS_PAGE } from "@/lib/heldBackIds";

const ORG = "12345678-1234-1234-1234-123456789abc";
const LIB = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const KL = "44444444-4444-4444-8444-444444444444";
const KD_MIRROR = "55555555-5555-4555-8555-555555555555";
const KD_UPLOAD = "66666666-6666-4666-8666-666666666666";
const KEY = `orgs/${ORG}/libraries/${LIB}/HSE-7.pdf`;
const UPLOAD_KEY = `orgs/${ORG}/knowledge/${KL}/1-manual.pdf`;

const allow = (type: string, id: string, actions: string[]) => ({ effect: "allow", subject: { type, id }, actions });
const deny = (type: string, id: string, actions: string[]) => ({ effect: "deny", subject: { type, id }, actions });
const acl = (rules: unknown[], visibility = "normal", inherit = true) => ({ inherit, visibility, rules });

function seed(opts: {
  folderAcl?: unknown; docAcl?: unknown; docVisibility?: string; docIndex?: unknown;
  teams?: string[]; mirrorKey?: string; archived?: boolean; versionKey?: string;
} = {}) {
  db.tables = {
    org_members: [
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active" },
    ],
    team_members: (opts.teams ?? []).map((t) => ({ uid: "u-viewer", team_id: t })),
    teams: [{ id: "T-eng", org_id: ORG, supervisor_user_id: null }],
    libraries: [{ id: LIB, org_id: ORG, name: "Operations", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    collections: [{
      id: FOLDER, org_id: ORG, library_id: LIB, parent_id: null, path_ids: [], name: "Crude 200", path_names: ["Crude 200"],
      acl: opts.folderAcl ?? null, visibility: "normal", owner_user_id: null, deleted_at: null,
    }],
    documents: [{
      id: DOC, org_id: ORG, library_id: LIB, collection_id: FOLDER, document_number: "HSE-7", title: "Incident procedure",
      acl: opts.docAcl ?? null, visibility: opts.docVisibility ?? "normal", acl_index: opts.docIndex ?? null,
      is_private: false, scope: null, created_by: "u-dc", owner_user_id: null,
      status: "Issued", archived_at: null, current_version_id: "v1", ai_excluded: false, name: null,
    }],
    document_versions: [{
      id: "v1", record_id: DOC, org_id: ORG, file_url: opts.versionKey ?? KEY, file_type: "application/pdf",
      archived_at: opts.archived ? "2026-10-01T00:00:00Z" : null, archive_id: opts.archived ? "ar-1" : null,
      revision_label: "A", size: 10,
    }],
    knowledge_libraries: [{ id: KL, org_id: ORG, name: "Process knowledge" }],
    knowledge_documents: [
      {
        id: KD_UPLOAD, org_id: ORG, library_id: KL, name: "manual.pdf", file_key: UPLOAD_KEY, file_size: 5,
        page_count: 2, pages_indexed: 2, status: "ready", error: null, created_by_name: "Ann", created_at: "2026-10-01T00:00:00Z",
        source_id: null, source_document_id: null, source_rev: null, vision_pages: 0, empty_pages: 0,
        vision_failed_pages: [], vision_partial_accepted: false, chunk_version: 2,
      },
      {
        id: KD_MIRROR, org_id: ORG, library_id: KL, name: "HSE-7 — Incident procedure", file_key: opts.mirrorKey ?? KEY, file_size: 10,
        page_count: 4, pages_indexed: 4, status: "ready", error: null, created_by_name: null, created_at: "2026-10-01T00:00:01Z",
        source_id: "src-1", source_document_id: DOC, source_rev: "A", vision_pages: 1, empty_pages: 0,
        vision_failed_pages: [], vision_partial_accepted: false, chunk_version: 2,
      },
    ],
    knowledge_sources: [],
    archive_settings: [],
    audit_logs: [],
  };
  db.errors = {};
  db.failEq = {};
  db.missingColumns = {};
  db.maxRows = 100000;
  db.rpc = { user_is_effective_owner: () => false };
  db.inserts = [];
  db.selects = [];
  db.signed = 0;
  db.signedKeys = [];
  db.user = { id: "u-viewer", email: "v@example.com" };
}

async function openMirror(id = KD_MIRROR, uid = "u-viewer") {
  db.user = { id: uid, email: `${uid}@example.com` };
  const res = await mirrorUrl(new NextRequest(`https://app/api/knowledge/mirror-url?id=${encodeURIComponent(id)}`, { headers: { authorization: "Bearer t" } }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}
/** Today's path: the viewer signing the mirror's key at the bytes door. */
async function openKeyAtDoor(uid = "u-viewer") {
  db.user = { id: uid, email: `${uid}@example.com` };
  const res = await downloadUrl(new NextRequest(`https://app/api/storage/download-url?path=${encodeURIComponent(KEY)}&inline=1`, { headers: { authorization: "Bearer t" } }));
  return res.status;
}
const restrictedReads = () => db.inserts.filter((i) => i.table === "audit_logs" && (i.row as Row).action === "CONTROLLER_RESTRICTED_READ").length;

beforeEach(() => seed());

describe("KACL-5 criterion 4 / KACL-7 criterion 3 — the library list never selects a mirror's file_key", () => {
  it("reproduction → fix: a mirror row reaches the browser without its key; an upload keeps its key, read as before", async () => {
    const list = await listKnowledgeDocuments(KL);
    expect(list.map((d) => [d.id, d.fileKey])).toEqual([[KD_UPLOAD, UPLOAD_KEY], [KD_MIRROR, null]]);
    const kdSelects = db.selects.filter((s) => s.table === "knowledge_documents");
    // uploads: the whole row (select "*"), only source_document_id IS NULL
    expect(kdSelects.find((s) => s.filters.includes("is:source_document_id"))?.columns).toBe("*");
    // mirrors: never "*" and never file_key
    const mirrorSel = kdSelects.filter((s) => s.filters.includes("not:source_document_id"));
    expect(mirrorSel.length).toBeGreaterThan(0);
    for (const s of mirrorSel) {
      expect(s.columns).not.toBe("*");
      expect(s.columns.split(",").map((c) => c.trim())).not.toContain("file_key");
    }
    // HEAD read every row with one select("*") — the shape this replaces
    expect(kdSelects.some((s) => s.columns === "*" && !s.filters.includes("is:source_document_id"))).toBe(false);
  });
  it("regression: a mirror row keeps every field the page shows (name, revision, counts, chunker, source link)", async () => {
    const m = (await listKnowledgeDocuments(KL)).find((d) => d.id === KD_MIRROR)!;
    expect(m).toMatchObject({
      name: "HSE-7 — Incident procedure", sourceDocumentId: DOC, sourceId: "src-1", sourceRev: "A",
      pageCount: 4, pagesIndexed: 4, status: "ready", visionPages: 1, chunkVersion: 2, fileKey: null,
    });
    const u = (await listKnowledgeDocuments(KL)).find((d) => d.id === KD_UPLOAD)!;
    expect(u).toMatchObject({ name: "manual.pdf", fileKey: UPLOAD_KEY, chunkVersion: 2, createdByName: "Ann" });
  });
  it("an older database (no 20261122 columns) still lists the mirror, chunker unknown as under select('*'); still no key", async () => {
    db.missingColumns.knowledge_documents = ["chunk_version", "empty_pages", "vision_failed_pages", "vision_partial_accepted"];
    const list = await listKnowledgeDocuments(KL);
    const m = list.find((d) => d.id === KD_MIRROR)!;
    expect(m.fileKey).toBeNull();
    expect(m.chunkVersion).toBeUndefined();
    expect(MIRROR_LIST_COLUMN_TIERS.every((t) => !t.split(",").map((c) => c.trim()).includes("file_key"))).toBe(true);
  });
  it("review fix: creation order by the parsed time — a whole-second stamp lists before a fractional one in the same second; ties by id", async () => {
    // PostgREST drops trailing zero fractions: '…:01+00:00' is earlier than
    // '…:01.5+00:00', but sorts after it as text ('.' collates before '+').
    const kd = db.tables.knowledge_documents;
    kd.find((r) => r.id === KD_UPLOAD)!.created_at = "2026-10-01T10:00:00+00:00";
    kd.find((r) => r.id === KD_MIRROR)!.created_at = "2026-10-01T10:00:00.5+00:00";
    expect((await listKnowledgeDocuments(KL)).map((d) => d.id)).toEqual([KD_UPLOAD, KD_MIRROR]);
    // …and the other way round within the same second
    kd.find((r) => r.id === KD_UPLOAD)!.created_at = "2026-10-01T10:00:00.25+00:00";
    kd.find((r) => r.id === KD_MIRROR)!.created_at = "2026-10-01T10:00:00+00:00";
    expect((await listKnowledgeDocuments(KL)).map((d) => d.id)).toEqual([KD_MIRROR, KD_UPLOAD]);
    // equal stamps: a stable order by id, across the two reads
    kd.find((r) => r.id === KD_UPLOAD)!.created_at = "2026-10-01T10:00:00+00:00";
    kd.find((r) => r.id === KD_MIRROR)!.created_at = "2026-10-01T10:00:00+00:00";
    expect((await listKnowledgeDocuments(KL)).map((d) => d.id)).toEqual([KD_MIRROR, KD_UPLOAD].sort());
  });
  it("a failed read is the empty list it always was", async () => {
    db.errors.knowledge_documents = { message: "statement timeout" };
    expect(await listKnowledgeDocuments(KL)).toEqual([]);
  });
});

describe("KACL-5 criterion 4 / KACL-7 criterion 3 — /api/knowledge/mirror-url decides through the bytes door and answers a URL, never the key", () => {
  it("a reader of the source opens the mirror as today: a signed inline URL, no key in the answer, never cached", async () => {
    const r = await openMirror();
    expect(r.status).toBe(200);
    expect(r.body.url).toBe("https://signed.example/get");
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain("HSE-7.pdf");
    expect(r.cache).toBe("no-store");
    expect(db.signed).toBe(1);
  });
  it("reproduction → fix: a member an allow-list on the source's folder leaves out gets no key, no URL and no bytes — the source is restricted", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read", "download"])]) });
    const r = await openMirror();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: MIRROR_SOURCE_RESTRICTED, restricted: true });
    expect(r.text).not.toContain(KEY);
    expect(db.signed).toBe(0);
    // …and the member inside the allow-list opens it (regression)
    seed({ folderAcl: acl([allow("team", "T-eng", ["read", "download"])]), teams: ["T-eng"] });
    expect((await openMirror()).status).toBe(200);
  });
  it("parity: for every case the route answers exactly what the viewer's old path (the key at the door) answered — no reader gains or loses", async () => {
    const cases: Array<{ name: string; seed: Parameters<typeof seed>[0]; uid?: string }> = [
      { name: "no ACL anywhere", seed: {} },
      { name: "folder allow-list, outside", seed: { folderAcl: acl([allow("team", "T-eng", ["read"])]) } },
      { name: "folder allow-list, inside", seed: { folderAcl: acl([allow("team", "T-eng", ["read"])]), teams: ["T-eng"] } },
      { name: "download-only grant", seed: { folderAcl: acl([allow("role", "Viewer", ["download"])]) } },
      { name: "private document, no grant", seed: { docVisibility: "private", docAcl: acl([], "private") } },
      { name: "hidden, discover only", seed: { docVisibility: "hidden", docAcl: acl([allow("role", "Viewer", ["discover"])], "hidden") } },
      { name: "explicit download deny", seed: { docIndex: { deny: { users: { download: ["u-viewer"] } } } } },
      { name: "role read deny", seed: { docAcl: acl([deny("role", "Viewer", ["read", "download"])]) } },
      { name: "controller on a restricted folder (DEC-43)", seed: { folderAcl: acl([allow("team", "T-eng", ["read"])]) }, uid: "u-dc" },
    ];
    for (const c of cases) {
      seed(c.seed);
      const door = await openKeyAtDoor(c.uid);
      seed(c.seed);
      const route = (await openMirror(KD_MIRROR, c.uid)).status;
      expect({ case: c.name, ok: route === 200 }).toEqual({ case: c.name, ok: door === 200 });
      if (door !== 200) expect({ case: c.name, route }).toEqual({ case: c.name, route: 403 });
    }
  });
  it("DEC-43 kept: a controller served only by the tier is recorded, as at the door", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    expect((await openMirror(KD_MIRROR, "u-dc")).status).toBe(200);
    expect(restrictedReads()).toBe(1);
  });
  it("a fault fails closed and says so: the door's lookup, the mirror read, the binding read", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]), teams: ["T-eng"] });
    db.errors.collections = { message: "statement timeout" };
    let r = await openMirror();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: MIRROR_ACCESS_UNVERIFIED });
    expect(db.signed).toBe(0);
    seed();
    db.errors.knowledge_documents = { message: "statement timeout" };
    r = await openMirror();
    expect(r.status).toBe(503);
    seed();
    db.failEq["document_versions|record_id"] = { message: "statement timeout" };
    r = await openMirror();
    expect(r.status).toBe(503);
    expect(db.signed).toBe(0);
  });
  it("the decision is about the mirror's SOURCE: a key that is not a revision of it, or under another workspace, is refused (409), never signed", async () => {
    seed({ mirrorKey: `orgs/${ORG}/libraries/${LIB}/OTHER.pdf` });
    let r = await openMirror();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MIRROR_UNBOUND });
    // a legacy key (no orgs/ prefix) that is NOT a revision of the source
    seed({ mirrorKey: "legacy/HSE-7.pdf" });
    r = await openMirror();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MIRROR_UNBOUND });
    const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
    seed({ mirrorKey: `orgs/${OTHER_ORG}/libraries/x/HSE-7.pdf`, versionKey: `orgs/${OTHER_ORG}/libraries/x/HSE-7.pdf` });
    r = await openMirror();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MIRROR_KEY_OUTSIDE_WORKSPACE });
    expect(db.signed).toBe(0);
  });
  it("review fix: a bound key from before the orgs/ prefix is decided by the door's own gate (the same predicate), then signed — never refused outright, never signed on membership alone", async () => {
    const LEGACY = "libraries/HSE-7.pdf";
    // a reader of the source opens it, as today
    seed({ mirrorKey: LEGACY, versionKey: LEGACY });
    let r = await openMirror();
    expect(r.status).toBe(200);
    expect(r.body.url).toBe("https://signed.example/get");
    expect(r.text).not.toContain(LEGACY);
    expect(db.signed).toBe(1);
    // a member the source's allow-list leaves out: restricted, nothing signed
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, folderAcl: acl([allow("team", "T-eng", ["read", "download"])]) });
    r = await openMirror();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: MIRROR_SOURCE_RESTRICTED, restricted: true });
    expect(db.signed).toBe(0);
    // …the member inside it opens it
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, folderAcl: acl([allow("team", "T-eng", ["read", "download"])]), teams: ["T-eng"] });
    expect((await openMirror()).status).toBe(200);
    // an explicit download deny binds, as at the door
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, docIndex: { deny: { users: { download: ["u-viewer"] } } } });
    expect((await openMirror()).status).toBe(403);
    // DEC-43: a controller served only by the tier is recorded
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    expect((await openMirror(KD_MIRROR, "u-dc")).status).toBe(200);
    expect(restrictedReads()).toBe(1);
    // a fault in the gate fails closed and says so
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, folderAcl: acl([allow("team", "T-eng", ["read"])]), teams: ["T-eng"] });
    db.errors.collections = { message: "statement timeout" };
    r = await openMirror();
    expect(r).toMatchObject({ status: 503, body: { error: MIRROR_ACCESS_UNVERIFIED } });
    expect(db.signed).toBe(0);
    // an archived legacy file answers the archive identity, never the key
    seed({ mirrorKey: LEGACY, versionKey: LEGACY, archived: true });
    r = await openMirror();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ archived: true, archiveId: "ar-1", fileName: "HSE-7.pdf" });
    expect(r.text).not.toContain(LEGACY);
  });
  it("review fix: a stored key the storage guard refuses is a permanent 409 that says so — never '503 try again', never signed", async () => {
    for (const bad of ["https://files.example/HSE-7.pdf", "libraries/../HSE-7.pdf", "libraries//HSE-7.pdf"]) {
      seed({ mirrorKey: bad, versionKey: bad });
      const r = await openMirror();
      expect({ bad, status: r.status, body: r.body }).toEqual({ bad, status: 409, body: { error: MIRROR_KEY_INVALID } });
    }
    expect(db.signed).toBe(0);
    // the permanent refusals promise no re-sync (a re-sync copies the same reference)
    for (const m of [MIRROR_KEY_OUTSIDE_WORKSPACE, MIRROR_UNBOUND, MIRROR_KEY_INVALID]) expect(m).not.toMatch(/re-sync/i);
  });
  it("an archived file answers the archive identity (never the key), as the door does", async () => {
    seed({ archived: true });
    const r = await openMirror();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ archived: true, archiveId: "ar-1", fileName: "HSE-7.pdf" });
    expect(r.text).not.toContain(KEY);
  });
  it("who may ask: a stranger learns nothing (404); an upload opens from its own key (400); no session 401; a bad id 400", async () => {
    let r = await openMirror(KD_MIRROR, "u-stranger");
    expect(r).toMatchObject({ status: 404, body: { error: MIRROR_NOT_FOUND } });
    r = await openMirror(KD_UPLOAD);
    expect(r).toMatchObject({ status: 400, body: { error: MIRROR_IS_UPLOAD } });
    r = await openMirror("not-a-uuid");
    expect(r.status).toBe(400);
    db.user = null;
    const res = await mirrorUrl(new NextRequest(`https://app/api/knowledge/mirror-url?id=${KD_MIRROR}`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(401);
  });
});

describe("KACL-5 criterion 4 / KACL-7 criterion 3 — the viewer asks the route for a mirror and says when the source is restricted", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const url = new URL(String(input), "https://app");
      return mirrorUrl(new NextRequest(url, { headers: (init?.headers ?? {}) as Record<string, string> }));
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("a readable mirror: the URL; every open asks the route (nothing remembered by document id)", async () => {
    seed();
    const id = "77777777-7777-4777-8777-777777777771";
    db.tables.knowledge_documents.push({ ...db.tables.knowledge_documents[1], id });
    expect(await getKnowledgeMirrorUrl(id)).toBe("https://signed.example/get");
    expect(await getKnowledgeMirrorUrl(id)).toBe("https://signed.example/get");
    expect(calls).toBe(2);
    expect(db.signedKeys).toEqual([KEY, KEY]);
  });
  it("fix pass (blocker): a mirror re-pointed to its source's new revision opens the NEW revision's file on the next open — never the superseded one", async () => {
    seed();
    const id = "77777777-7777-4777-8777-777777777773";
    db.tables.knowledge_documents.push({ ...db.tables.knowledge_documents[1], id });
    expect(await getKnowledgeMirrorUrl(id)).toBe("https://signed.example/get");
    expect(db.signedKeys).toEqual([KEY]);
    // The source publishes revision B; the sync updates the SAME row (same
    // knowledge document id, new file_key, new source_rev) — as
    // lib/knowledgeSourceSync does — and the page re-lists.
    const KEY_B = `orgs/${ORG}/libraries/${LIB}/HSE-7-rev-B.pdf`;
    db.tables.document_versions.push({ ...db.tables.document_versions[0], id: "v2", file_url: KEY_B, revision_label: "B" });
    db.tables.documents[0].current_version_id = "v2";
    const row = db.tables.knowledge_documents.find((r) => r.id === id)!;
    row.file_key = KEY_B;
    row.source_rev = "B";
    const listed = await listKnowledgeDocuments(KL);
    expect(listed.find((d) => d.id === id)).toMatchObject({ sourceRev: "B", fileKey: null });
    expect(await getKnowledgeMirrorUrl(id)).toBe("https://signed.example/get");
    expect(calls).toBe(2);
    expect(db.signedKeys).toEqual([KEY, KEY_B]);
    // and the library source carries no browser-side URL memory for mirrors
    const lib = readFileSync(join(process.cwd(), "lib/knowledge.ts"), "utf8");
    expect(lib).not.toMatch(/mirrorUrlCache/);
  });
  it("a restricted mirror throws KnowledgeMirrorRestrictedError carrying 'the source is restricted' — the words the viewer shows", async () => {
    seed({ folderAcl: acl([allow("team", "T-eng", ["read"])]) });
    const id = "77777777-7777-4777-8777-777777777772";
    db.tables.knowledge_documents.push({ ...db.tables.knowledge_documents[1], id });
    await expect(getKnowledgeMirrorUrl(id)).rejects.toBeInstanceOf(KnowledgeMirrorRestrictedError);
    await expect(getKnowledgeMirrorUrl(id)).rejects.toThrow(MIRROR_SOURCE_RESTRICTED);
  });
  it("source pins: the viewer signs an upload's key as before and opens a mirror by id through the route; the page hands a mirror's null key and its id", () => {
    const viewer = readFileSync(join(process.cwd(), "components/knowledge/CitedPageViewer.tsx"), "utf8");
    expect(viewer).toMatch(/\? getSignedUrlForPath\(view\.fileKey, undefined, \{ inline: true \}\)/);
    expect(viewer).toMatch(/\? getKnowledgeMirrorUrl\(view\.documentId\)/);
    expect(viewer).toMatch(/\}, \[view\.fileKey, view\.documentId\]\);/);
    const page = readFileSync(join(process.cwd(), "app/(protected)/knowledge/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/fileKey: string \| null;/);
    const lib = readFileSync(join(process.cwd(), "lib/knowledge.ts"), "utf8");
    expect(lib).toMatch(/fileKey: r\.source_document_id \? null :/);
  });
});

describe("KACL-9 residual — the pickers read the held-back flag checked", () => {
  const browse = () => flowsBrowse(new NextRequest(`https://app/api/flows/browse?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
  const status = () => areaStatus(new NextRequest(`https://app/api/area/knowledge-status?orgId=${ORG}&unitCode=200`, { headers: { authorization: "Bearer t" } }));
  // Held back, and (as the sync leaves it) no mirror of it in any library.
  const held = () => {
    db.tables.documents[0].ai_excluded = true;
    db.tables.knowledge_documents = db.tables.knowledge_documents.filter((r) => !r.source_document_id);
  };
  const withUnit = () => { db.tables.codebook_entries = [{ org_id: ORG, kind: "unit", code: "200", label: "Crude", meta: {} }]; };

  it("regression: a held-back document shows as held back in the PFD picker", async () => {
    held();
    const res = await browse();
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('"state":"held_back"');
  });
  it("reproduction → fix: an errored held-back read WITHHOLDS the map (503, said) — it never shows the held-back document as AI-readable", async () => {
    held();
    db.failEq["documents|ai_excluded"] = { message: "statement timeout" };
    const res = await browse();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: HELD_BACK_UNREADABLE });
  });
  it("a database without the column holds nothing back (as the sync reads it)", async () => {
    db.failEq["documents|ai_excluded"] = { message: "column documents.ai_excluded does not exist", code: "42703" };
    const res = await browse();
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("held_back");
  });
  it("area status: a held-back document is not counted; an errored read withholds the counts (503); a missing column counts it", async () => {
    withUnit();
    let res = await status();
    expect(res.status).toBe(200);
    const count = async (r: Response) => ((await r.json()).suggestions as Array<{ id: string; docCount: number }>).find((f) => f.id === FOLDER)?.docCount;
    expect(await count(res)).toBe(1);
    held();
    res = await status();
    expect(await count(res)).toBe(0);
    db.failEq["documents|ai_excluded"] = { message: "statement timeout" };
    res = await status();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: HELD_BACK_UNREADABLE });
    db.failEq["documents|ai_excluded"] = { message: "column documents.ai_excluded does not exist", code: "42703" };
    res = await status();
    expect(res.status).toBe(200);
    expect(await count(res)).toBe(1);
  });
  it("the read pages by keyset past any row cap: every held-back document is read", async () => {
    db.tables.documents = Array.from({ length: HELD_BACK_IDS_PAGE * 2 + 7 }, (_, i) => ({
      id: `d-${String(i).padStart(5, "0")}`, org_id: ORG, ai_excluded: true,
    }));
    db.maxRows = 1000;
    const out = await readHeldBackIds(ORG);
    expect(out.ok && out.ids.size).toBe(HELD_BACK_IDS_PAGE * 2 + 7);
    db.failEq["documents|ai_excluded"] = { message: "boom" };
    expect(await readHeldBackIds(ORG)).toEqual({ ok: false, error: "boom" });
  });
});
