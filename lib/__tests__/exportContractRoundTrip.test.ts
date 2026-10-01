// lib/__tests__/exportContractRoundTrip.test.ts
//
// admin-and-org Round G, package P2 — the export contract, end to end, with
// the real producers (lib/dataExport.ts runOrgExport; lib/exportRunner.ts
// buildAndDeliverExport, the server ZIP; lib/clientBackup.ts runFullBackup,
// the browser Full ZIP), the real reader (lib/dataRestore.ts
// readBackupArchive) and the real restore routes (/begin + /apply-table),
// over the in-memory database P1's round trip uses.
//
//   BKP-4  `orgs` is read by its id; `project_members` and
//          `curated_collection_items` (no org_id) through THIS workspace's
//          parents — and only those; a backup with them is COMPLETE, and they
//          restore. Reproduced on base 2290b94: the export read all three
//          `.eq("org_id", …)`, which the database refuses (42703 — the stand-in
//          below answers that error for a column the table does not have),
//          so every backup was INCOMPLETE and carried them empty.
//   BKP-1  no exported row, and no entry of either ZIP, carries a share,
//          intake or portal token, or a destination credential (the export
//          half landed as document-control EGR-7; this pins it by value).
//   BKP-2 / BKP-9  every registered binary — native CAD source, knowledge
//          PDF, output template and example, vendor quote, photo, attachment,
//          markup, plot plan, covers, page backgrounds, logo — is in the file
//          manifest, packed into both ZIPs and put back; a key in a column the
//          registry does not know is carried and counted
//          (`files.unregistered`); a key an audit row merely mentions is not.
//   Fix pass: the storage checks run FILE_CHECK_CONCURRENCY at a time under a
//          time budget (never one by one), and every table is read in a
//          stable, unique order by keyset, past a server row cap, and
//          reconciled against its count (intelligence ILIFE-6, export half).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { db, type Row } from "./helpers/restoreMemoryDb";
import { censusSchema } from "./helpers/schemaKeys";

// The in-memory stand-in filters `.eq(col, v)` on any column; PostgREST
// refuses a filter on a column the table does not have (42703). Wrap `from`
// so a read filtered by a missing column errors as the database does — the
// shape of the base-2290b94 failure this package fixes (BKP-4).
const census = censusSchema();
/** Called before every read statement the export's client sends (a hook for concurrent-write cases), with the
 *  statement's `.in()` values and whether it is a head count. */
const hooks = vi.hoisted(() => ({ onRead: null as null | ((table: string, q: { inValues: unknown[] | null; head: boolean }) => void) }));
vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@target.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});
vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  const { censusSchema: cs } = await import("./helpers/schemaKeys");
  const shapes = cs();
  const from = (table: string) => {
    const b = mem.from(table) as Record<string, unknown>;
    const eq = b.eq as (c: string, v: unknown) => unknown;
    const inn = b.in as (c: string, v: unknown[]) => unknown;
    const gt = b.gt as (c: string, v: unknown) => unknown;
    const order = b.order as (c: string, o?: unknown) => unknown;
    const select = b.select as (cols?: unknown, o?: unknown) => unknown;
    let bad: string | null = null;
    let inValues: unknown[] | null = null;
    let head = false;
    const check = (c: string) => { if (shapes.get(table) && !shapes.get(table)!.columns.has(c)) bad = c; };
    b.select = (cols?: unknown, o?: { head?: boolean }) => { head = o?.head === true; select(cols, o); return b; };
    b.eq = (c: string, v: unknown) => { check(c); eq(c, v); return b; };
    b.in = (c: string, v: unknown[]) => { check(c); inValues = v; inn(c, v); return b; };
    b.gt = (c: string, v: unknown) => { check(c); gt(c, v); return b; };
    b.order = (c: string, o?: unknown) => { check(c); order(c, o); return b; };
    const then = b.then as (res: (v: unknown) => void, rej: (e: unknown) => void) => void;
    b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      if (bad) return res({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } });
      hooks.onRead?.(table, { inValues, head });
      return then(res, rej);
    };
    return b;
  };
  return { createClient: () => ({ from }) };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { runOrgExport, collectFilePaths, keysetAfter, FILE_CHECK_CONCURRENCY, FILE_CHECK_CEILING_MS, type DataExportEnvelope } from "@/lib/dataExport";
import { buildAndDeliverExport } from "@/lib/exportRunner";
import { runFullBackup } from "@/lib/clientBackup";
import { REDACT_COLUMNS } from "@/lib/exportTables";
import {
  readBackupArchive, planRestore, runChunkedRestore, RESTORE_CONTRACT_TABLES, isSkippedTable,
  type RestorePost, type BackupZipLike, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";

const SRC = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const TARGET = "55555555-5555-4555-8555-555555555555";
const key = (p: string) => `orgs/${SRC}/${p}`;
const K = {
  pdf: key("libraries/lib-1/P-101.pdf"),
  dwg: key("libraries/lib-1/P-101.dwg"),
  kpdf: key("knowledge/kl-1/pump-manual.pdf"),
  tmpl: key("output-templates/datasheet.docx"),
  example: key("output-examples/datasheet-filled.docx"),
  quote: key("project-costs/proj-1/quote-1-acme.pdf"),
  photo: key("assets/as-1/photos/1.jpg"),
  attachment: key("project-intake/proj-1/redlines/r1.pdf"),
  markup: key("markups/mr-1.pdf"),
  plot: key("plot-plans/pp-1.png"),
  libCover: key("branding/covers/lib-1.png"),
  colCover: key("branding/covers/col-1.png"),
  libBackground: key("branding/backgrounds/lib-1.jpg"),
  colBackground: key("branding/backgrounds/col-1.png"),
  logo: key("branding/logo-1.svg"),
  unregistered: key("notes/n-1/field-photo.jpg"),
};
const MENTIONED_ONLY = key("deleted/old-revision.pdf"); // an audit row's history
const BYTES: Record<string, string> = Object.fromEntries(Object.values(K).map((k) => [k, "DATA"]));
const SECRETS = {
  share: "shr_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  intake: "itk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  intakeHash: "8b1a9953c4611296a827abf8c47804d7e6c49c6b1a9953c4611296a827abf8c4",
  portal: "ptl_aa11bb22cc33dd44ee55ff6677889900",
  accessKey: "enc:v1:ACCESSKEYCIPHERTEXT",
  secretKey: "enc:v1:SECRETKEYCIPHERTEXT",
  webhookSecret: "enc:v1:WEBHOOKSECRETCIPHERTEXT",
};

function seedSource() {
  db.rows = {
    orgs: [{ id: SRC, name: "Acme" }, { id: OTHER, name: "Other tenant" }],
    org_members: [{ org_id: SRC, uid: "u-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    libraries: [{ id: "lib-1", org_id: SRC, name: "P&IDs", cover_image_url: K.libCover,
      page_config: { header: { height: "md" }, background: { type: "image", imagePath: K.libBackground, opacity: 0.18, tint: "neutral" } } }],
    collections: [{ id: "col-1", org_id: SRC, library_id: "lib-1", parent_id: null, name: "Area 1", cover_image_url: K.colCover,
      page_config: { background: { type: "image", imagePath: K.colBackground } } }],
    documents: [{ id: "doc-1", org_id: SRC, library_id: "lib-1", collection_id: "col-1", title: "P-101", created_by: "u-alice" }],
    document_versions: [{ id: "v-1", org_id: SRC, record_id: "doc-1", revision_label: "A", file_url: K.pdf, source_file_key: K.dwg, size: 4, created_by: "u-alice" }],
    projects: [{ id: "proj-1", org_id: SRC, name: "Turnaround" }, { id: "proj-x", org_id: OTHER, name: "Not ours" }],
    // BKP-4: the roster has no org_id — only the row under THIS workspace's project is ours
    project_members: [
      { id: "pm-1", project_id: "proj-1", user_id: "u-alice", role: "lead" },
      { id: "pm-x", project_id: "proj-x", user_id: "u-elsewhere", role: "member" },
    ],
    curated_collections: [{ id: "cc-1", org_id: SRC, library_id: "lib-1", name: "Turnover set", scope: "org", pinned: false, created_by: "u-alice" },
      { id: "cc-x", org_id: OTHER, name: "Not ours", scope: "org", pinned: false, created_by: "u-elsewhere" }],
    curated_collection_items: [
      { collection_id: "cc-1", document_id: "doc-1", sort_order: 0 },
      { collection_id: "cc-x", document_id: "doc-x", sort_order: 0 },
    ],
    knowledge_libraries: [{ id: "kl-1", org_id: SRC, name: "Vendor manuals" }],
    knowledge_documents: [{ id: "kd-1", org_id: SRC, library_id: "kl-1", name: "Pump manual", file_key: K.kpdf, file_size: 4, status: "ready" }],
    output_templates: [{ id: "ot-1", org_id: SRC, name: "Datasheet", template_file_key: K.tmpl, example_files: [{ key: K.example, name: "filled.docx" }] }],
    cost_documents: [{ id: "cd-1", org_id: SRC, project_id: "proj-1", kind: "quote", status: "received", file_url: K.quote, vendor_name: "Acme Valves" }],
    assets: [{ id: "as-1", org_id: SRC, library_id: "lib-1", tag: "P-101A" }],
    asset_photos: [{ id: "ap-1", org_id: SRC, asset_id: "as-1", file_url: K.photo, file_size: 4, status: "active", uploaded_by: "u-alice" }],
    tickets: [{ id: "tk-1", org_id: SRC, title: "Redlines", attachments: [{ url: K.attachment, size: "0.01 MB", name: "REDLINE_r1.pdf" }] }],
    markup_requests: [{ id: "mr-1", org_id: SRC, document_id: "doc-1", requested_by_user_id: "u-alice", requested_from_user_id: "u-alice", status: "done", shared_markup_url: K.markup }],
    plot_plans: [{ id: "pp-1", org_id: SRC, name: "Unit 100", image_path: K.plot, markers: [] }],
    org_configurations: [{ id: "cfg-1", org_id: SRC, key: "branding", data: { logoPath: K.logo } }],
    // a key no registered column names (a future evidence field, inside JSON)
    notes: [{ id: "n-1", org_id: SRC, body: "Field photo", task_meta: { evidence: [{ path: K.unregistered }] } }],
    // history, not a reference
    audit_logs: [{ id: "al-1", org_id: SRC, action: "STORAGE_DELETE", details: { path: MENTIONED_ONLY } }],
    // BKP-1: live bearer credentials
    document_shares: [{ id: "sh-1", org_id: SRC, document_id: "doc-1", token: SECRETS.share, revoked_at: null }],
    project_intake_links: [{ id: "il-1", org_id: SRC, project_id: "proj-1", company_name: "Vendor", token: SECRETS.intake, token_hash: SECRETS.intakeHash, token_prefix: SECRETS.intake.slice(0, 6) }],
    transmittals: [{ id: "tr-1", org_id: SRC, project_id: "proj-1", seq: 1, number: "TR-001", status: "issued", items: [], portal_token: SECRETS.portal }],
    export_destinations: [{ id: "ed-1", org_id: SRC, name: "Nightly", destination_type: "s3", enabled: true, bucket: "acme-backups",
      access_key_id_encrypted: SECRETS.accessKey, secret_access_key_encrypted: SECRETS.secretKey, webhook_secret_encrypted: SECRETS.webhookSecret,
      schedule_kind: "daily", include_files: true, created_by: "u-alice", next_run_at: "2026-09-30T00:00:00Z" }],
  };
}
function seedTarget() {
  db.rows = {
    orgs: [{ id: TARGET, name: "Acme" }],
    org_members: [{ org_id: TARGET, uid: "t-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    users: [{ id: "t-alice", email: "alice@acme.com" }, { id: "admin-1", email: "admin@target.io" }],
  };
  db.authUsers = new Set(["t-alice", "admin-1"]);
  db.writes = []; db.attempts = [];
}
/** Every FOREIGN KEY between restorable tables and onto users, as the database enforces them. */
function enforceForeignKeys() {
  const restorable = new Set([...RESTORE_CONTRACT_TABLES].filter((t) => !isSkippedTable(t)));
  const fks: typeof db.fks = {};
  const generated: typeof db.generated = {};
  for (const t of restorable) {
    for (const f of census.get(t)?.fks ?? []) {
      if (f.columns.length === 1 && (restorable.has(f.parent) || f.parent === "users")) (fks[t] ??= []).push({ column: f.columns[0], parent: f.parent });
    }
    const g = [...(census.get(t)?.generated ?? [])];
    if (g.length) generated[t] = g;
  }
  expect(fks.project_members).toContainEqual({ column: "project_id", parent: "projects" });
  db.fks = fks;
  db.generated = generated;
}
/** The structured-export endpoint and storage's GET of a presigned URL (which, like R2, states the object's Content-Length). */
const storageGet = vi.fn(async (url: string): Promise<Response> => {
  const k = decodeURIComponent(url.replace("https://r2.test/", ""));
  if (!BYTES[k]) return new Response("missing", { status: 404 });
  const body = new TextEncoder().encode(BYTES[k]);
  return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
});
function stubFetch(envelope: DataExportEnvelope) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/data-export/structured")) return new Response(JSON.stringify(envelope), { status: 200 });
    return storageGet(url);
  }));
}
const exportEnvelope = () =>
  runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com" });
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await (path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable)(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
async function restoreInto(envelope: RestoreEnvelopeLike) {
  const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
  return runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
}
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];
/** Every text entry of a ZIP outside schema/ (the bundled DDL), concatenated. */
async function zipText(zip: JSZip): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || name.startsWith("schema/")) continue;
    parts.push(await zip.file(name)!.async("string"));
  }
  return parts.join("\n");
}

/** HeadObject's answer for an object that is not there, as the S3 client throws it. */
const notFound = () => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });

beforeEach(() => {
  hooks.onRead = null;
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false;
  db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  db.keys.curated_collection_items = [["collection_id", "document_id"]];
  db.keys.project_members = [["id"], ["project_id", "user_id"]];
  db.keys.project_intake_links = [["id"], ["token"]];
  db.keys.transmittals = [["id"], ["org_id", "number"]];
  seedSource();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("BKP-4 — the three tables without org_id are exported by their own key, and the backup is COMPLETE", () => {
  it("the stand-in answers 42703 for a filter on a column the table lacks (the base failure, reproduced)", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient("https://x", "k") as unknown as { from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => PromiseLike<{ error: { code: string } | null }> } } };
    for (const t of ["orgs", "project_members", "curated_collection_items"]) {
      const { error } = await sb.from(t).select("*").eq("org_id", SRC);
      expect(error?.code, t).toBe("42703");
    }
  });

  it("orgs by its id, rosters and curated contents through THIS workspace's parents — never another tenant's", async () => {
    const env = await exportEnvelope();
    expect(env.manifest.tables.filter((t) => t.error)).toEqual([]);
    expect(env.manifest.complete).toBe(true);
    expect(env.manifest.notes[0]).toBe("This document is a complete export of every record this organization owns.");
    expect(env.tables.orgs).toEqual([{ id: SRC, name: "Acme" }]);
    expect((env.tables.project_members as Row[]).map((r) => r.id)).toEqual(["pm-1"]);
    expect(env.tables.curated_collection_items).toEqual([{ collection_id: "cc-1", document_id: "doc-1", sort_order: 0 }]);
    expect(env.manifest.tables.find((t) => t.name === "project_members")).toEqual({ name: "project_members", rowCount: 1 });
  });

  it("a parent that cannot be read fails its child loudly — never exported unscoped, never silently empty", async () => {
    db.readError.projects = "statement timeout";
    const env = await exportEnvelope();
    expect(env.manifest.complete).toBe(false);
    expect(env.manifest.tables.find((t) => t.name === "projects")?.error).toMatch(/statement timeout/);
    expect(env.manifest.tables.find((t) => t.name === "project_members")?.error).toMatch(/parent table projects was not exported/);
    expect(env.tables.project_members).toEqual([]);
    expect(env.manifest.notes[0]).toMatch(/INCOMPLETE BACKUP — 2 table\(s\).*projects, project_members/);
  });

  it("many parents: the child is read in chunks and every row arrives once", async () => {
    db.rows.projects = Array.from({ length: 320 }, (_, i) => ({ id: `p-${i}`, org_id: SRC, name: `P${i}` }));
    db.rows.project_members = db.rows.projects.map((p, i) => ({ id: `m-${i}`, project_id: p.id, user_id: "u-alice", role: "member" }));
    const env = await exportEnvelope();
    expect((env.tables.project_members as Row[]).map((r) => r.id).sort()).toEqual(db.rows.project_members.map((r) => String(r.id)).sort());
  });
});

describe("BKP-1 — no exported row carries a live bearer credential", () => {
  const leaked = (text: string) => Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([n]) => n);

  it("the envelope: every redacted column is null and no token value appears anywhere", async () => {
    const env = await exportEnvelope();
    expect(leaked(JSON.stringify(env))).toEqual([]);
    for (const [table, r] of Object.entries(REDACT_COLUMNS)) {
      expect((env.tables[table] as Row[]).length, table).toBeGreaterThan(0); // not vacuous
      for (const row of env.tables[table] as Row[]) for (const c of r.columns) expect(row[c], `${table}.${c}`).toBeNull();
    }
    expect(Object.keys(env.manifest.redactedColumns).sort()).toEqual(Object.keys(REDACT_COLUMNS).sort());
    expect(env.manifest.notes.join(" ")).toMatch(/share links and vendor intake links must be RE-ISSUED/);
  });

  it("the server ZIP and the browser Full ZIP: no token value in any entry", async () => {
    const env = await exportEnvelope();
    stubFetch(env);
    const out = await buildAndDeliverExport({
      supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
      includeFiles: true, delivery: { kind: "inline" },
    });
    expect(leaked(await zipText(await JSZip.loadAsync(out.zipBytes!)))).toEqual([]);
    const saved: Uint8Array[] = [];
    await runFullBackup(SRC, { onProgress: () => undefined, save: async (blob) => { saved.push(new Uint8Array(await blob.arrayBuffer())); } });
    for (const bytes of saved) expect(leaked(await zipText(await JSZip.loadAsync(bytes)))).toEqual([]);
  });
});

describe("BKP-2 / BKP-9 — every binary the database references is in the backup, and restores", () => {
  it("the manifest lists every registered key and the unregistered one, counts it, and skips a mere mention", async () => {
    const env = await exportEnvelope();
    const paths = env.files.map((f) => f.path).sort();
    expect(paths).toEqual(Object.values(K).sort());
    expect(paths).not.toContain(MENTIONED_ONLY);
    expect(env.manifest.files).toMatchObject({ count: Object.keys(K).length, missing: 0, unregistered: 1, unchecked: 0, archivedOffline: 0 });
    const note = env.manifest.notes.find((n) => n.includes("does not yet track"));
    expect(note).toMatch(/1 file\(s\) in this workspace's storage are named by record field\(s\) the app does not yet track as file references: notes\.task_meta\. A scan of every exported value found them; 1 is included in this backup\. /);
    // written for the customer: no repository path
    expect(env.manifest.notes.join(" ")).not.toMatch(/lib\/|\.ts\b/);
  });

  it("the page backgrounds (libraries / collections.page_config) are carried; nothing is reported unregistered for them", async () => {
    const env = await exportEnvelope();
    expect(env.files.map((f) => f.path)).toEqual(expect.arrayContaining([K.libBackground, K.colBackground]));
    expect(env.manifest.notes.join(" ")).not.toMatch(/page_config/);
  });

  it("a key whose object is gone is counted missing, whichever collector found it", async () => {
    const { r2 } = await import("@/lib/r2");
    vi.mocked(r2.send).mockImplementation((async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === K.unregistered || cmd.input.Key === K.markup) throw notFound();
      return { ContentLength: 4 };
    }) as never);
    try {
      const env = await exportEnvelope();
      expect(env.manifest.files.missing).toBe(2);
      expect(env.files.find((f) => f.path === K.unregistered)?.presignedUrl).toBe("");
      // the note no longer says a file it could not find IS in the backup
      const note = env.manifest.notes.find((n) => n.includes("does not yet track"));
      expect(note).toMatch(/0 are included in this backup and 1 was not found in storage \(counted with the missing files\)/);
      expect(note).not.toMatch(/ARE included/);
    } finally {
      vi.mocked(r2.send).mockImplementation((async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) as never);
    }
  });

  it("a check that fails with anything but not-found (throttle, timeout, 5xx) keeps the file's URL: unchecked, never missing — and both ZIPs still pack it", async () => {
    const { r2 } = await import("@/lib/r2");
    const throttled = Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    const timedOut = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    vi.mocked(r2.send).mockImplementation((async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === K.dwg) throw throttled;
      if (cmd.input.Key === K.quote) throw timedOut;
      if (cmd.input.Key === K.markup) throw notFound();
      return { ContentLength: 4 };
    }) as never);
    try {
      const env = await exportEnvelope();
      for (const k of [K.dwg, K.quote]) {
        const f = env.files.find((x) => x.path === k)!;
        expect(f.presignedUrl, k).toBe(`https://r2.test/${k}`);
        expect(f.size, k).toBeNull();
      }
      // a real not-found is still missing, with no URL
      expect(env.files.find((x) => x.path === K.markup)?.presignedUrl).toBe("");
      expect(env.manifest.files).toMatchObject({ missing: 1, unchecked: 2 });
      const note = env.manifest.notes.find((n) => n.includes("could not be checked against storage"));
      expect(note).toMatch(/^2 file\(s\) could not be checked against storage: 2 because storage answered the check with an error other than "not found"/);
      expect(note).not.toMatch(/time limit/);
      // the browser Full ZIP and the server ZIP both pack the two unchecked files (a file with no URL is skipped by both)
      stubFetch(env);
      const saved: Uint8Array[] = [];
      await runFullBackup(SRC, { onProgress: () => undefined, save: async (blob) => { saved.push(new Uint8Array(await blob.arrayBuffer())); } });
      const browser = await JSZip.loadAsync(saved[0]);
      expect(Object.keys(JSON.parse(await browser.file("files-manifest.json")!.async("string")))).toEqual(expect.arrayContaining([K.dwg, K.quote]));
      const out = await buildAndDeliverExport({
        supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
        includeFiles: true, delivery: { kind: "inline" },
      });
      const server = await JSZip.loadAsync(out.zipBytes!);
      expect(server.file(`files/${K.dwg}`)).not.toBeNull();
      expect(server.file(`files/${K.quote}`)).not.toBeNull();
    } finally {
      vi.mocked(r2.send).mockImplementation((async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) as never);
    }
  });

  it("the server ZIP carries every binary and the org-less tables, and a fresh workspace restores them end to end", async () => {
    stubFetch(await exportEnvelope());
    seedSource();
    const out = await buildAndDeliverExport({
      supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
      includeFiles: true, delivery: { kind: "inline" },
    });
    const zip = (await JSZip.loadAsync(out.zipBytes!)) as unknown as BackupZipLike & JSZip;
    const read = await readBackupArchive([{ name: "manufacturing-os-backup.zip", zip }]);
    expect(read.layout).toBe("manifest+tables");
    expect(read.files.map((f) => f.key).sort()).toEqual(Object.values(K).sort());
    expect(read.warnings).toEqual([]);
    expect((read.envelope.tables.project_members as Row[]).map((r) => r.id)).toEqual(["pm-1"]);

    seedTarget();
    enforceForeignKeys();
    const result = await restoreInto(read.envelope);
    expect(result.stoppedAt).toBeNull();
    expect(result.tables.flatMap((t) => (t.refused ?? []).map((r) => `${t.name}:${r.code}`))).toEqual([]);
    // the roster and the curated contents land, bound to the restored parents
    expect(rowsOf("project_members")).toEqual([expect.objectContaining({ id: "pm-1", project_id: "proj-1", user_id: "t-alice" })]);
    expect(rowsOf("curated_collection_items")).toEqual([expect.objectContaining({ collection_id: "cc-1", document_id: "doc-1" })]);
    // every key column follows the files to the new workspace's prefix
    const moved = (p: string) => p.replace(`orgs/${SRC}/`, `orgs/${TARGET}/`);
    expect(rowsOf("cost_documents")[0].file_url).toBe(moved(K.quote));
    expect(rowsOf("document_versions")[0]).toMatchObject({ file_url: moved(K.pdf), source_file_key: moved(K.dwg) });
    expect(rowsOf("knowledge_documents")[0].file_key).toBe(moved(K.kpdf));
    // nothing restored can fire or be presented (DEC-45, P1)
    expect(String(rowsOf("document_shares")[0].token)).toMatch(/^restored-/);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: false, next_run_at: null, secret_access_key_encrypted: null });
  });

  it("the browser Full ZIP packs every binary too", async () => {
    const env = await exportEnvelope();
    stubFetch(env);
    const saved: Array<{ bytes: Uint8Array }> = [];
    const result = await runFullBackup(SRC, { onProgress: () => undefined, save: async (blob) => { saved.push({ bytes: new Uint8Array(await blob.arrayBuffer()) }); } });
    expect(result).toMatchObject({ filesTotal: Object.keys(K).length, filesPacked: Object.keys(K).length, cancelled: false });
    const parts = [];
    for (const s of saved) parts.push({ name: `part-${parts.length + 1}.zip`, zip: (await JSZip.loadAsync(s.bytes)) as unknown as BackupZipLike });
    const read = await readBackupArchive(parts);
    expect(read.files.map((f) => f.key).sort()).toEqual(Object.values(K).sort());
    expect((read.envelope.tables.curated_collection_items as Row[]).length).toBe(1);
  });
});

describe("the storage checks run side by side, in manifest order, under a time budget (fix pass: export runtime)", () => {
  // Every ticket attachment records its size as TEXT ("0.01 MB"), so each one
  // (and every native source, quote, template, background) is checked against
  // storage. One at a time, thousands of them outran the routes' 300 s.
  const N = 60;
  function seedAttachments() {
    db.rows.tickets = Array.from({ length: N }, (_, i) => ({
      id: `tk-${String(i).padStart(3, "0")}`, org_id: SRC, title: `T${i}`,
      attachments: [{ url: key(`tickets/tk-${i}/r.pdf`), size: "0.01 MB", name: "r.pdf" }],
    }));
  }

  it("N text-sized attachments: N storage checks, several in flight at once (never more than the cap), results in manifest order", async () => {
    seedAttachments();
    const { r2 } = await import("@/lib/r2");
    let inFlight = 0; let peak = 0; const checked: string[] = [];
    vi.mocked(r2.send).mockImplementation((async (cmd: { input: { Key: string } }) => {
      inFlight++; peak = Math.max(peak, inFlight); checked.push(cmd.input.Key);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { ContentLength: 4, ContentType: "application/pdf" };
    }) as never);
    try {
      const env = await exportEnvelope();
      const sizeless = collectFilePaths(env.tables).filter((r) => r.size == null).map((r) => r.path);
      expect(sizeless.filter((p) => p.includes("/tickets/tk-"))).toHaveLength(N);
      expect(checked.sort()).toEqual([...sizeless, K.unregistered].sort()); // every size-less key, once
      expect(peak).toBeGreaterThan(1);                                     // not serialised
      expect(peak).toBeLessThanOrEqual(FILE_CHECK_CONCURRENCY);            // bounded
      // the manifest keeps collectFilePaths' order (the capped ZIP's embed order), whatever order the checks finished in
      expect(env.files.map((f) => f.path)).toEqual([...collectFilePaths(env.tables).map((r) => r.path), K.unregistered]);
      expect(env.files.filter((f) => f.path.includes("/tickets/tk-")).every((f) => f.size === 4)).toBe(true);
      expect(env.manifest.files).toMatchObject({ missing: 0, unchecked: 0 });
    } finally {
      vi.mocked(r2.send).mockImplementation((async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) as never);
    }
  });

  it("past the time budget a file is listed with its URL and no size, counted unchecked (not missing), and named in a note", async () => {
    seedAttachments();
    const { r2 } = await import("@/lib/r2");
    vi.mocked(r2.send).mockClear();
    const env = await runOrgExport({
      supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
      fileCheckBudgetMs: 0,
    });
    expect(vi.mocked(r2.send)).not.toHaveBeenCalled();
    const sizeless = env.files.filter((f) => f.size == null);
    expect(sizeless.length).toBeGreaterThan(N);
    expect(sizeless.every((f) => f.presignedUrl.startsWith("https://r2.test/"))).toBe(true);
    expect(env.manifest.files).toMatchObject({ missing: 0, unchecked: sizeless.length });
    expect(env.manifest.notes.join(" ")).toMatch(new RegExp(`${sizeless.length} file\\(s\\) could not be checked against storage within this export's time limit`));
  });

  it("a slow table dump shrinks the checks' budget: no check starts past the ceiling counted from the export's START, nor past the caller's deadline", async () => {
    seedAttachments();
    const { r2 } = await import("@/lib/r2");
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      // The dump "takes" 200 s (the clock jumps while the first table is read): the file phase
      // starts past FILE_CHECK_CEILING_MS from the export's start, so its own 90 s never begins.
      vi.mocked(r2.send).mockClear();
      hooks.onRead = (t) => { if (t === "documents" && skew === 0) skew = FILE_CHECK_CEILING_MS + 50_000; };
      const slow = await exportEnvelope();
      expect(vi.mocked(r2.send)).not.toHaveBeenCalled();
      const sizeless = slow.files.filter((f) => f.size == null);
      expect(sizeless.length).toBeGreaterThan(N);
      expect(slow.manifest.files.unchecked).toBe(sizeless.length);
      // A dump of 30 s leaves the checks their time: every size-less file is checked.
      skew = 0; vi.mocked(r2.send).mockClear();
      hooks.onRead = (t) => { if (t === "documents" && skew === 0) skew = 30_000; };
      const quick = await exportEnvelope();
      expect(vi.mocked(r2.send)).toHaveBeenCalled();
      expect(quick.manifest.files.unchecked).toBe(0);
      // A caller's own deadline, already passed, stops every check whatever the budget.
      skew = 0; hooks.onRead = null; vi.mocked(r2.send).mockClear();
      const capped = await runOrgExport({
        supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
        deadlineAt: Date.now() - 1,
      });
      expect(vi.mocked(r2.send)).not.toHaveBeenCalled();
      expect(capped.manifest.files.unchecked).toBe(capped.files.filter((f) => f.size == null).length);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("ILIFE-6 (export half) — every table is read once per row, in a stable order, past a row cap, and reconciled", () => {
  const docs = (n: number, prefix = "d") => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(4, "0")}`, org_id: SRC, library_id: "lib-1", title: `D${i}`,
  }));

  it("a server row cap below the page size no longer cuts a table short (base stopped at the first short page)", async () => {
    db.maxRows = 7;
    db.rows.documents = docs(25);
    const env = await exportEnvelope();
    expect((env.tables.documents as Row[]).map((r) => r.id)).toEqual(db.rows.documents.map((r) => r.id));
    expect(env.manifest.complete).toBe(true);
    // a composite-keyed table pages past the cap too
    db.rows.curated_collection_items = Array.from({ length: 12 }, (_, i) => ({ collection_id: "cc-1", document_id: `doc-${String(i).padStart(2, "0")}`, sort_order: i }));
    const env2 = await exportEnvelope();
    expect((env2.tables.curated_collection_items as Row[]).length).toBe(12);
  });

  it("a row deleted behind the cursor between pages moves no window — every other row arrives exactly once", async () => {
    db.rows.documents = docs(2500);
    let reads = 0;
    hooks.onRead = (t) => {
      if (t !== "documents") return;
      reads++;
      // read 1 = the count, read 2 = page 1 (d-0000..d-0999); before page 2, delete a row already read
      if (reads === 3) db.rows.documents = db.rows.documents.filter((r) => r.id !== "d-0005");
    };
    const env = await exportEnvelope();
    const ids = (env.tables.documents as Row[]).map((r) => String(r.id));
    expect(new Set(ids).size).toBe(ids.length);   // no row twice
    expect(ids).toContain("d-1000");               // the row an OFFSET window would have skipped
    expect(ids).toHaveLength(2500);                // d-0005 was read before it went
    expect(env.manifest.complete).toBe(true);
  });

  it("a read that ends short of the table's count before AND after is read again; one transient race heals", async () => {
    db.rows.documents = docs(2500);
    let reads = 0;
    hooks.onRead = (t) => {
      if (t !== "documents") return;
      reads++;
      if (reads === 3) {
        // between pages: ten unread rows go, ten land behind the cursor ("c-" sorts before "d-")
        db.rows.documents = [...db.rows.documents.filter((r) => !/^d-20(0\d)$/.test(String(r.id))), ...docs(10, "c")];
      }
    };
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "documents")).toEqual({ name: "documents", rowCount: 2500 });
    expect((env.tables.documents as Row[]).map((r) => String(r.id))).toEqual(expect.arrayContaining(["c-0000", "d-2499"]));
    expect(env.manifest.complete).toBe(true);
  });

  /** Between pages of the first read (and of the re-read when `twice`), ten unread rows go and ten land behind the cursor. */
  function churn(table: string, make: (n: number, prefix: string) => Row[], twice = true) {
    let reads = 0; let wave = 0;
    hooks.onRead = (t) => {
      if (t !== table) return;
      reads++;
      // after page 1 of EACH read. First read: 1 count, 2 page 1, 3 page 2, 4 page 3, 5 the empty page,
      // 6 the count after. The re-read: 7 count, 8 page 1, 9 page 2.
      if (reads === 3 || (twice && reads === 9)) {
        wave++;
        db.rows[table] = [...db.rows[table].filter((r) => !new RegExp(`^[a-z]-2${wave}0\\d$`).test(String(r.id))), ...make(10, `c${wave}`)];
      }
    };
    return () => wave;
  }

  it("still short on the second read: the backup is INCOMPLETE and names the counts — and the table KEEPS every row the reads found", async () => {
    db.rows.documents = docs(2500);
    const waves = churn("documents", docs);
    const env = await exportEnvelope();
    expect(waves()).toBe(2);
    expect(env.manifest.complete).toBe(false);
    const entry = env.manifest.tables.find((t) => t.name === "documents")!;
    expect(entry.error).toBeUndefined();
    expect(entry.short).toMatch(/read 2490 row\(s\), but the table held 2500 before the read and 2500 after it/);
    expect(entry.short).toMatch(/read twice: 2490 and 2490 row\(s\); the 2500 distinct row\(s\) the two reads found are included/);
    // The rows are kept, not thrown away: the second read's 2,490 (c1-*, and d-* less the
    // twenty deleted while it ran) plus the ten the first read found that the second did not.
    const ids = new Set((env.tables.documents as Row[]).map((r) => String(r.id)));
    expect(ids.size).toBe((env.tables.documents as Row[]).length);
    const expected = [...docs(2500).map((r) => r.id as string).filter((id) => !/^d-210\d$/.test(id)), ...docs(10, "c1").map((r) => r.id as string)];
    expect([...ids].sort()).toEqual(expected.sort());
    expect(entry.rowCount).toBe(2500);
    expect([...ids].some((id) => id.startsWith("c2-"))).toBe(false); // never read: the backup says it may be short
    expect(env.manifest.notes[0]).toMatch(/^⚠ INCOMPLETE BACKUP — 1 table\(s\) changed while they were read and came up short of their own row count twice; the rows that were read ARE included, but some rows may be missing: documents \(read 2490 row/);
    expect(env.manifest.notes[0]).not.toMatch(/could not be exported/);
  });

  it("a short PARENT still scopes its child: the child is exported through the rows read and marked short, never failed or emptied", async () => {
    const projects = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(4, "0")}`, org_id: SRC, name: `P${i}` }));
    db.rows.projects = projects(2500);
    db.rows.project_members = db.rows.projects.map((p, i) => ({ id: `m-${i}`, project_id: p.id, user_id: "u-alice", role: "member" }));
    const waves = churn("projects", projects);
    const env = await exportEnvelope();
    expect(waves()).toBe(2);
    const parent = env.manifest.tables.find((t) => t.name === "projects")!;
    const child = env.manifest.tables.find((t) => t.name === "project_members")!;
    expect(parent.short).toMatch(/read twice/);
    expect(child.error).toBeUndefined();
    expect(child.short).toMatch(/read through the 2500 row\(s\) of its parent table projects that the export could read; the read of projects came up short/);
    // every roster row of a project the export read is carried (2,500 projects: the merged reads,
    // which include p-220x, gone during the re-read); the ten projects deleted during the first
    // read (p-210x) were never read, so their roster rows are the ones the backup may be missing
    const carried = (env.tables.project_members as Row[]).map((r) => String(r.project_id));
    expect(child.rowCount).toBe(2490);
    expect(carried).toContain("p-2200");
    expect(carried.some((id) => /^p-210\d$/.test(id))).toBe(false);
    expect(env.manifest.complete).toBe(false);
    expect(env.manifest.notes[0]).toMatch(/2 table\(s\) changed while they were read/);
  });

  it("a composite-keyed table pages by keyset too: one delete of a row already read hides no live row (offset paging skipped one)", async () => {
    db.rows.document_equipment_suggestions = Array.from({ length: 1500 }, (_, i) => ({
      org_id: SRC, document_id: `doc-${String(i).padStart(4, "0")}`, status: "pending",
    }));
    let reads = 0;
    hooks.onRead = (t) => {
      if (t !== "document_equipment_suggestions") return;
      reads++;
      // read 1 = the count, read 2 = page 1 (doc-0000..doc-0999); before page 2, one row already read goes
      if (reads === 3) db.rows.document_equipment_suggestions = db.rows.document_equipment_suggestions.filter((r) => r.document_id !== "doc-0005");
    };
    const env = await exportEnvelope();
    const ids = (env.tables.document_equipment_suggestions as Row[]).map((r) => String(r.document_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("doc-1000");   // the live row an OFFSET window at 1000 skipped
    expect(ids).toHaveLength(1500);      // doc-0005 was read before it went
    expect(env.manifest.complete).toBe(true);
  });

  it("a two-column key whose leading column varies pages past a row cap with every row once", async () => {
    db.maxRows = 7;
    db.rows.document_favorites = ["u-a", "u-b", "u-c"].flatMap((u) => Array.from({ length: 5 }, (_, i) => ({ org_id: SRC, user_id: u, document_id: `doc-${i}` })));
    const env = await exportEnvelope();
    const got = (env.tables.document_favorites as Row[]).map((r) => `${r.user_id}/${r.document_id}`);
    expect(got).toEqual(db.rows.document_favorites.map((r) => `${r.user_id}/${r.document_id}`));
    expect(env.manifest.complete).toBe(true);
  });

  it("keysetAfter: (k1, k2) > (v1, v2) as PostgREST's or-syntax, quoting a value only when it holds a reserved character", () => {
    expect(keysetAfter(["collection_id", "document_id"], ["cc-1", "doc-9"])).toBe("collection_id.gt.cc-1,and(collection_id.eq.cc-1,document_id.gt.doc-9)");
    expect(keysetAfter(["org_id", "year"], [SRC, 2026])).toBe(`org_id.gt.${SRC},and(org_id.eq.${SRC},year.gt.2026)`);
    expect(keysetAfter(["a", "b"], ['x,"y"', "z.w"])).toBe('a.gt."x,\\"y\\"",and(a.eq."x,\\"y\\"",b.gt."z.w")');
  });

  it("the user-scoped table (notification_preferences) records a failed read as an error — the backup is INCOMPLETE, not complete with the table empty", async () => {
    db.rows.notification_preferences = [{ user_id: "u-alice", email_enabled: true }];
    db.readError.notification_preferences = "permission denied for table notification_preferences";
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "notification_preferences")).toEqual({
      name: "notification_preferences", rowCount: 0, error: "permission denied for table notification_preferences",
    });
    expect(env.manifest.complete).toBe(false);
    expect(env.manifest.notes[0]).toMatch(/INCOMPLETE BACKUP — 1 table\(s\) could not be exported and their data is NOT included: notification_preferences/);
    // and read cleanly, it is carried
    delete db.readError.notification_preferences;
    const ok = await exportEnvelope();
    expect(ok.tables.notification_preferences).toEqual([{ user_id: "u-alice", email_enabled: true }]);
    expect(ok.manifest.complete).toBe(true);
  });
});

describe("the server ZIP's embed loop: a size-unknown file is capped before it is buffered, and the route's deadline stops embedding (final review minors)", () => {
  const throttled = () => Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
  const build = (deadlineAt?: number) => buildAndDeliverExport({
    supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
    includeFiles: true, delivery: { kind: "inline" }, ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
  const json = async (zip: JSZip, name: string) => JSON.parse(await zip.file(name)!.async("string"));
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { r2 } = await import("@/lib/r2");
    vi.mocked(r2.send).mockImplementation((async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) as never);
  });

  it("a file the export could not size-check is held to the cap by the length storage reports, never buffered past it; with no length it is not embedded", async () => {
    const { r2 } = await import("@/lib/r2");
    // three files whose storage check failed: listed with their URL and no size (unchecked)
    vi.mocked(r2.send).mockImplementation((async (cmd: { input: { Key: string } }) => {
      if ([K.dwg, K.quote, K.tmpl].includes(cmd.input.Key)) throw throttled();
      return { ContentLength: 4 };
    }) as never);
    vi.stubEnv("EXPORT_MAX_EMBED_BYTES", "100");
    const big = { cancel: vi.fn(async () => undefined), arrayBuffer: vi.fn(async () => new ArrayBuffer(5000)) };
    const unsized = { cancel: vi.fn(async () => undefined), arrayBuffer: vi.fn(async () => new ArrayBuffer(4)) };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const k = decodeURIComponent(url.replace("https://r2.test/", ""));
      if (k === K.dwg) return { ok: true, status: 200, headers: new Headers({ "content-length": "5000" }), body: { cancel: big.cancel }, arrayBuffer: big.arrayBuffer };
      if (k === K.quote) return { ok: true, status: 200, headers: new Headers(), body: { cancel: unsized.cancel }, arrayBuffer: unsized.arrayBuffer };
      return storageGet(url);
    }));
    const out = await build();
    expect(big.arrayBuffer).not.toHaveBeenCalled();      // never buffered
    expect(unsized.arrayBuffer).not.toHaveBeenCalled();
    expect(big.cancel).toHaveBeenCalled();
    expect(unsized.cancel).toHaveBeenCalled();
    const zip = await JSZip.loadAsync(out.zipBytes!);
    expect(zip.file(`files/${K.dwg}`)).toBeNull();
    expect(zip.file(`files/${K.quote}`)).toBeNull();
    expect(zip.file(`files/${K.tmpl}`)).not.toBeNull(); // unchecked, but storage said 4 bytes: under the cap, embedded
    const omitted = await json(zip, "files-omitted.json");
    expect(omitted.files).toEqual([
      { path: K.dwg, size: 5000 },
      { path: K.quote, size: null, reason: "not embedded: storage did not report its size, so it could not be held to the embed cap" },
    ]);
    expect(omitted.reason).toMatch(/is not embedded, since it cannot be held to that cap \(1 here\)/);
    expect(await zip.file("README.md")!.async("string")).toMatch(/2 file\(s\) are NOT inside this ZIP .* 1 were left out because storage did not report their size\./);
  });

  it("past the route's deadline no file is fetched: the rest are listed omitted with the reason, the README says why, and the archive is delivered and restorable", async () => {
    const env = await exportEnvelope();
    stubFetch(env);
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      if (fetched.length === 3) skew = 120_000; // the third download "takes" two minutes
      return storageGet(url);
    }));
    try {
      const out = await build(realNow() + 60_000);
      expect(fetched).toHaveLength(3);
      const zip = await JSZip.loadAsync(out.zipBytes!);
      const packed = Object.keys(await json(zip, "files-manifest.json"));
      expect(packed).toHaveLength(3);
      const omitted = await json(zip, "files-omitted.json");
      expect(omitted.files).toHaveLength(Object.keys(K).length - 3);
      for (const o of omitted.files) expect(o, o.path).toEqual({ path: o.path, size: 4, reason: "not embedded: the export reached its time limit" });
      expect([...packed, ...omitted.files.map((o: { path: string }) => o.path)].sort()).toEqual(Object.values(K).sort());
      expect(omitted.reason).toMatch(/^This export stopped embedding binaries when it neared its time limit, so the archive is delivered rather than lost; 13 file\(s\) here say so/);
      expect(await zip.file("README.md")!.async("string")).toMatch(/13 were left out because the export reached its time limit while embedding/);
      expect(out.diagnostics.find((d) => d.step === "files:omitted")?.detail).toMatch(/^13 omitted: 13 at the time limit, 0 of unknown size/);
      // every record is in the archive and reads back as a backup
      const read = await readBackupArchive([{ name: "manufacturing-os-backup.zip", zip: zip as unknown as BackupZipLike }]);
      expect(read.layout).toBe("manifest+tables");
      expect(read.files).toHaveLength(3);
      expect((read.envelope.tables.document_versions as Row[]).length).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("a small export (every size known, under the cap, well before the deadline) is built exactly as before: every file fetched once in manifest order, the same entries, steps and texts", async () => {
    const env = await exportEnvelope();
    stubFetch(env);
    storageGet.mockClear();
    const out = await build();
    expect(storageGet.mock.calls.map((c) => c[0])).toEqual(env.files.map((f) => f.presignedUrl));
    const zip = await JSZip.loadAsync(out.zipBytes!);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !n.startsWith("schema/"));
    expect(names).toEqual([
      "manifest.json",
      ...Object.keys(env.tables).map((t) => `tables/${t}.json`),
      ...env.files.map((f) => `files/${f.path}`),
      "files-manifest.json",
      "README.md",
    ]);
    expect(await zip.file("README.md")!.async("string")).not.toMatch(/Omitted binaries/);
    expect(out.diagnostics.map((d) => d.step)).toEqual([
      "envelope:start", "envelope:done", "zip:build", "schema:migrations", "files:fetch", "files:done", "zip:compress", "zip:ready",
    ]);
    // the over-cap path keeps its texts byte for byte
    vi.stubEnv("EXPORT_MAX_EMBED_BYTES", "8");
    const capped = await build();
    const cz = await JSZip.loadAsync(capped.zipBytes!);
    const omitted = await json(cz, "files-omitted.json");
    expect(omitted.reason).toBe("Embedded binaries are capped at 8 B per ZIP to protect the export runtime. These files are NOT in this ZIP. Download them via the JSON export's presigned URLs, or shed old history first to shrink the set.");
    expect(omitted.files[0]).toEqual({ path: env.files[2].path, size: 4 });
    expect(await cz.file("README.md")!.async("string")).toContain(`\n## ⚠ Omitted binaries\n\n${omitted.files.length} file(s) exceeded this ZIP's embedded-bytes cap and are NOT inside — see files-omitted.json for the list and how to fetch them.\n`);
    expect(capped.diagnostics.find((d) => d.step === "files:omitted")?.detail).toBe(`${omitted.files.length} over the 8 B cap`);
  });

  it("both ZIP routes pass their own deadline (route start + maxDuration less the headroom) into the build", async () => {
    const { exportEmbedDeadline, EMBED_HEADROOM_MS } = await import("@/lib/exportRunner");
    expect(exportEmbedDeadline(1_000_000, 300)).toBe(1_000_000 + 300_000 - EMBED_HEADROOM_MS);
    expect(EMBED_HEADROOM_MS).toBeGreaterThanOrEqual(60_000);
    for (const route of ["run", "run-scheduled"]) {
      const src = readFileSync(join(process.cwd(), "app", "api", "data-export", route, "route.ts"), "utf8");
      expect(src, route).toMatch(/export const maxDuration = 300;/);
      expect(src, route).toMatch(/\{\n  \/\/ [^\n]*\n  const routeStart = Date\.now\(\);/); // the handler's first statement
      expect(src, route).toMatch(/deadlineAt: exportEmbedDeadline\(routeStart, maxDuration\),\n\s*\}\);/);
    }
  });
});

describe("notification_preferences is read through the members PARENT_ID_CHUNK (150) ids at a time (review minor: the URL of one read)", () => {
  // A UUID-shaped uid is 36 characters, so one `.in()` over ~400 members is a ~15 KB URL, which the
  // server refuses (414 / header too large). The stand-in refuses an id list over 8 KB the same way.
  const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const members = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `om-${String(i).padStart(4, "0")}`, org_id: SRC, uid: uid(i), email: `m${i}@acme.com`, role: "Viewer", roles: ["Viewer"], status: "active",
  }));
  const prefsFor = (rows: Row[]) => rows.map((m) => ({ user_id: m.uid, email_enabled: true }));
  /** Every notification_preferences statement's id count; an id list over 8 KB is refused like a too-long URL. */
  function watchPrefs(extra?: (q: { inValues: unknown[] | null; head: boolean }) => void) {
    const sizes: Array<{ ids: number; head: boolean }> = [];
    hooks.onRead = (t, q) => {
      if (t !== "notification_preferences") return;
      sizes.push({ ids: q.inValues?.length ?? 0, head: q.head });
      if ((q.inValues ?? []).join(",").length > 8000) db.readError.notification_preferences = "414 Request-URI Too Large";
      else delete db.readError.notification_preferences;
      extra?.(q);
    };
    return sizes;
  }

  it("400 members: three reads of at most 150 ids, every member's row carried, the backup COMPLETE (one read of 400 was refused)", async () => {
    db.rows.org_members = members(400);
    db.rows.notification_preferences = prefsFor(db.rows.org_members);
    const sizes = watchPrefs();
    const env = await exportEnvelope();
    expect(sizes.every((s) => s.ids > 0 && s.ids <= 150)).toBe(true);
    expect(sizes.filter((s) => !s.head).map((s) => s.ids)).toEqual([150, 150, 100]);
    expect((env.tables.notification_preferences as Row[]).map((r) => r.user_id)).toEqual(db.rows.org_members.map((m) => m.uid));
    expect(env.manifest.tables.find((t) => t.name === "notification_preferences")).toEqual({ name: "notification_preferences", rowCount: 400 });
    expect(env.manifest.complete).toBe(true);
  });

  it("a slice whose read comes up short twice marks the table short with that slice's counts, and keeps every other slice's rows", async () => {
    db.rows.org_members = members(160);
    db.rows.notification_preferences = prefsFor(db.rows.org_members);
    // member 150's row (the first of the second slice) is seen by every count and returned by no page
    const phantom = db.rows.notification_preferences[150];
    watchPrefs((q) => {
      if (!(q.inValues ?? []).includes(uid(150))) return;
      const rows = db.rows.notification_preferences.filter((r) => r !== phantom);
      db.rows.notification_preferences = q.head ? [...rows, phantom] : rows;
    });
    const env = await exportEnvelope();
    const entry = env.manifest.tables.find((t) => t.name === "notification_preferences")!;
    expect(entry.error).toBeUndefined();
    expect(entry.rowCount).toBe(159);
    expect(entry.short).toMatch(/^read 9 row\(s\), but the table held 10 before the read and 10 after it/);
    expect((env.tables.notification_preferences as Row[]).map((r) => r.user_id)).toEqual(
      db.rows.org_members.map((m) => m.uid).filter((u) => u !== uid(150)),
    );
    expect(env.manifest.complete).toBe(false);
    expect(env.manifest.notes[0]).toMatch(/1 table\(s\) changed while they were read .*notification_preferences \(read 9 row/);
  });

  it("a short org_members read marks the table short too (preferences of members the read missed are not in it)", async () => {
    db.rows.org_members = members(20);
    db.rows.notification_preferences = prefsFor(db.rows.org_members);
    // one member row every org_members count sees and no page returns
    const ghost = { ...members(21)[20], id: "om-0000a" };
    hooks.onRead = (t, q) => {
      if (t !== "org_members") return;
      const rows = db.rows.org_members.filter((r) => r !== ghost);
      db.rows.org_members = q.head ? [...rows, ghost] : rows;
    };
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "org_members")?.short).toMatch(/read twice/);
    const entry = env.manifest.tables.find((t) => t.name === "notification_preferences")!;
    expect(entry.rowCount).toBe(20);
    expect(entry.short).toMatch(/^read through the 20 row\(s\) of its parent table org_members that the export could read; the read of org_members came up short/);
    expect(env.manifest.complete).toBe(false);
  });

  it("a slice whose read errors fails the table loudly (as any parent-keyed child), never a complete backup", async () => {
    db.rows.org_members = members(160);
    db.rows.notification_preferences = prefsFor(db.rows.org_members);
    watchPrefs((q) => {
      if ((q.inValues ?? []).includes(uid(150))) db.readError.notification_preferences = "canceling statement due to statement timeout";
    });
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "notification_preferences")).toEqual({
      name: "notification_preferences", rowCount: 0, error: "canceling statement due to statement timeout",
    });
    expect(env.tables.notification_preferences).toEqual([]);
    expect(env.manifest.complete).toBe(false);
  });

  it("an org_members read that failed fails the table — never a clean, empty one", async () => {
    db.readError.org_members = "permission denied for table org_members";
    db.rows.notification_preferences = [{ user_id: "u-alice", email_enabled: true }];
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "notification_preferences")?.error).toMatch(/parent table org_members was not exported/);
    expect(env.manifest.complete).toBe(false);
  });
});

describe("/data-portability promises what the export carries (BKP-9, BKP-1)", () => {
  const page = readFileSync(join(process.cwd(), "app", "data-portability", "page.tsx"), "utf8");
  it("no 'every byte you've ever uploaded'; the files are what the records reference, and offline archives are named", () => {
    expect(page).not.toMatch(/every byte you&apos;ve ever uploaded|every byte you've ever uploaded/);
    expect(page).toMatch(/every file your records reference/);
    expect(page).toMatch(/native CAD sources, redlines, knowledge-library PDFs, output templates, vendor quotes/);
    expect(page).toMatch(/space-archive zips/);
  });
  it("'every column verbatim' names the credential columns exported empty", () => {
    expect(page).toMatch(/except the credential columns \(share, vendor-intake and transmittal-portal link tokens; backup-destination keys\), which are exported empty/);
  });
});
