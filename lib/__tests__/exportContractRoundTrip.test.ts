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
//          markup, plot plan, covers, logo — is in the file manifest, packed
//          into both ZIPs and put back; a key in a column the registry does
//          not know is carried and counted (`files.unregistered`); a key an
//          audit row merely mentions is not.

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
    let bad: string | null = null;
    const check = (c: string) => { if (shapes.get(table) && !shapes.get(table)!.columns.has(c)) bad = c; };
    b.eq = (c: string, v: unknown) => { check(c); eq(c, v); return b; };
    b.in = (c: string, v: unknown[]) => { check(c); inn(c, v); return b; };
    const then = b.then as (res: (v: unknown) => void, rej: (e: unknown) => void) => void;
    b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      if (bad) return res({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } });
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

import { runOrgExport, type DataExportEnvelope } from "@/lib/dataExport";
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
    libraries: [{ id: "lib-1", org_id: SRC, name: "P&IDs", cover_image_url: K.libCover }],
    collections: [{ id: "col-1", org_id: SRC, library_id: "lib-1", parent_id: null, name: "Area 1", cover_image_url: K.colCover }],
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
function stubFetch(envelope: DataExportEnvelope) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/data-export/structured")) return new Response(JSON.stringify(envelope), { status: 200 });
    const k = decodeURIComponent(url.replace("https://r2.test/", ""));
    return BYTES[k] ? new Response(new TextEncoder().encode(BYTES[k]), { status: 200 }) : new Response("missing", { status: 404 });
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

beforeEach(() => {
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
    expect(env.manifest.files).toMatchObject({ count: Object.keys(K).length, missing: 0, unregistered: 1, archivedOffline: 0 });
    expect(env.manifest.notes.join(" ")).toMatch(/1 file\(s\) under this workspace's storage prefix are referenced from column\(s\) the storage-key registry \(lib\/storageKeyRegistry\.ts\) does not list: notes\.task_meta/);
  });

  it("a key whose object is gone is counted missing, whichever collector found it", async () => {
    const { r2 } = await import("@/lib/r2");
    vi.mocked(r2.send).mockImplementation((async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === K.unregistered || cmd.input.Key === K.markup) throw new Error("NotFound");
      return { ContentLength: 4 };
    }) as never);
    try {
      const env = await exportEnvelope();
      expect(env.manifest.files.missing).toBe(2);
      expect(env.files.find((f) => f.path === K.unregistered)?.presignedUrl).toBe("");
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
