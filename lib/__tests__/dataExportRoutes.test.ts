// lib/__tests__/dataExportRoutes.test.ts
//
// admin-and-org Round G, package P3 — the export routes, scheduled exports
// and destination hygiene.
//
//   BKP-8   every /api/data-export route is Admin-only through the one gate
//           (lib/adminGate.ts, the data-export surface); standalone notes —
//           each author's private scratchpad — are still carried (so a
//           restore brings them back) and counted, while the user decides
//           (DEC-44 (A&O P3) §4); the DATA_EXPORT row names the exporter's
//           role and every file that leaves is named (DATA_EXPORT_FILES): row
//           by row for a person's export or a webhook push, against the
//           destination's last full list for a bucket push.
//   BKP-13  the scheduled push writes its DATA_EXPORT row as a machine
//           (user_id NULL — DEC-44 (A&O P3)) and the write is CHECKED: an
//           export that cannot be recorded is refused; every export rings the
//           controllers' bell, the scheduled one included; creating or
//           enabling a destination (or re-pointing an enabled one) does too.
//   BKP-11  enabling a destination requires its credentials (Done-when 3).
//   BILL-3  a bucket destination whose plan lapsed is disabled, never deleted,
//           under SUBSCRIPTION_ENFORCE (Done-when 3); enabling one re-checks.
//   BKP-6   a retention purge's failures and real deletion count reach the
//           run row and the destination card; the page asks for a prefix
//           before it takes a retention.
//
// The database is the in-memory stand-in the export/restore round trips use
// (lib/__tests__/helpers/restoreMemoryDb.ts); the caller's identity is the
// vi.hoisted `state`; the ZIP builder is replaced only where a route test
// needs to see what it is asked to do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, type Row } from "./helpers/restoreMemoryDb";

const state = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.EXPORT_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  return {
    roles: ["Admin"] as string[],
    userId: "u-admin",
    delivered: [] as Array<Record<string, unknown>>,
    deliver: null as null | ((p: Record<string, unknown>) => Promise<unknown>),
    s3: (_cmd: string, _input: Record<string, unknown>): unknown => ({}),
  };
});

vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return { createClient: () => ({ from: mem.from }) };
});
vi.mock("@/lib/serverAuth", async (importOriginal) => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    ...(await importOriginal<typeof import("@/lib/serverAuth")>()),
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string, allowed: string[]) => {
      if (!orgId) return { error: "orgId is required", status: 400 };
      if (!state.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
      return { userId: state.userId, email: "me@acme.com", orgId, role: state.roles[0], roles: [...state.roles], admin: { from: mem.from } };
    }),
  };
});
vi.mock("@/lib/exportRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exportRunner")>()),
  buildAndDeliverExport: vi.fn(async (p: Record<string, unknown>) => {
    state.delivered.push(p);
    if (state.deliver) return state.deliver(p);
    return { bytes: 10, fileCount: 0, tableCount: 1, totalRows: 1, diagnostics: [{ ts: "t", step: "zip:ready" }], zipBytes: new Uint8Array([80, 75]) };
  }),
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class FakeS3 {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) { return state.s3(cmd.constructor.name, cmd.input); }
  }
  return { ...real, S3Client: FakeS3 };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/pdf" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));

import { runOrgExport, PRIVATE_NOTES_CARRIED, EXPORT_FILES_PER_AUDIT_ROW, isPrivateNote, exportFileListDigest } from "@/lib/dataExport";
import { s3PurgeOlderThan, retentionProblem, destinationCredentialGap } from "@/lib/exportRunner";
import { planRestore } from "@/lib/dataRestore";
import { ALERT_LINKS } from "@/lib/exportAlerts";
import { encryptSecret } from "@/lib/serverCrypto";
import { adminSurface } from "@/lib/adminSurfaces";
import { GET as structuredGET } from "@/app/api/data-export/structured/route";
import { POST as runPOST } from "@/app/api/data-export/run/route";
import { POST as scheduledPOST } from "@/app/api/data-export/run-scheduled/route";
import { GET as destinationsGET, POST as destinationsPOST } from "@/app/api/data-export/destinations/route";
import { PATCH as destinationPATCH, DELETE as destinationDELETE } from "@/app/api/data-export/destinations/[id]/route";
import { POST as destinationTEST } from "@/app/api/data-export/destinations/[id]/test/route";
import { GET as runsGET } from "@/app/api/data-export/runs/route";

const ORG = "77777777-7777-4777-8777-777777777777";
const key = (p: string) => `orgs/${ORG}/${p}`;
const req = (url: string, init: { method?: string; body?: unknown; auth?: string } = {}) => new NextRequest(`https://app${url}`, {
  method: init.method ?? "GET",
  headers: { authorization: init.auth ?? "Bearer t", "content-type": "application/json" },
  ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];
const audits = (action: string) => rowsOf("audit_logs").filter((r) => r.action === action);
const bells = () => rowsOf("notifications").filter((n) => n.kind === "security_export");

function seed() {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme", subscription_status: "active", subscribed_plan: "growth" }],
    org_members: [
      { id: "om-1", org_id: ORG, uid: "u-admin", email: "me@acme.com", role: "Admin", roles: ["Admin"], status: "active" },
      { id: "om-2", org_id: ORG, uid: "u-admin2", email: "ann@acme.com", role: "Admin", roles: ["Admin"], status: "active" },
      { id: "om-3", org_id: ORG, uid: "u-dc", email: "dc@acme.com", role: "Manager", roles: ["Manager", "DocCtrl"], status: "active" },
      { id: "om-4", org_id: ORG, uid: "u-viewer", email: "v@acme.com", role: "Viewer", roles: ["Viewer"], status: "active" },
      { id: "om-5", org_id: ORG, uid: "u-gone", email: "gone@acme.com", role: "Admin", roles: ["Admin"], status: "inactive" },
    ],
    audit_logs: [],
    notifications: [],
    export_runs: [],
    export_destinations: [],
  };
}

beforeEach(() => {
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false;
  db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  state.roles = ["Admin"]; state.userId = "u-admin"; state.delivered = []; state.deliver = null;
  state.s3 = () => ({});
  seed();
});
const prevEnforce = process.env.SUBSCRIPTION_ENFORCE;
afterEach(() => {
  if (prevEnforce === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = prevEnforce;
});

// ─── BKP-8: Admin-only, through the one gate ───────────────────────────────

const ROUTES: Array<[string, () => Promise<Response>]> = [
  ["GET structured", () => structuredGET(req(`/api/data-export/structured?orgId=${ORG}`))],
  ["POST run", () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }))],
  ["GET runs", () => runsGET(req(`/api/data-export/runs?orgId=${ORG}`))],
  ["GET destinations", () => destinationsGET(req(`/api/data-export/destinations?orgId=${ORG}`))],
  ["POST destinations", () => destinationsPOST(req("/api/data-export/destinations", { method: "POST", body: { orgId: ORG, name: "Hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/x" } }))],
  ["PATCH destination", () => destinationPATCH(req("/api/data-export/destinations/d-1", { method: "PATCH", body: { orgId: ORG, name: "x" } }), params("d-1"))],
  ["DELETE destination", () => destinationDELETE(req(`/api/data-export/destinations/d-1?orgId=${ORG}`, { method: "DELETE" }), params("d-1"))],
  ["POST destination test", () => destinationTEST(req(`/api/data-export/destinations/d-1/test?orgId=${ORG}`, { method: "POST" }), params("d-1"))],
];

describe("BKP-8 — every data-export route is Admin-only, through the one gate", () => {
  for (const roles of [["Manager"], ["DocCtrl"], ["Manager", "DocCtrl"], ["Viewer"]]) {
    it(`${roles.join("+")} is refused 403 by every route, and nothing is exported or written`, async () => {
      state.roles = roles;
      for (const [name, call] of ROUTES) {
        const res = await call();
        expect(res.status, name).toBe(403);
        expect(((await res.json()) as { error: string }).error, name).toBe(adminSurface("data-export")!.denied);
      }
      expect(state.delivered).toEqual([]);
      expect(audits("DATA_EXPORT")).toEqual([]);
      expect(rowsOf("export_destinations")).toEqual([]);
      expect(rowsOf("export_runs")).toEqual([]);
    });
  }

  it("an Admin is admitted (by the collection: an Admin with a Viewer headline too)", async () => {
    state.roles = ["Viewer", "Admin"];
    const json = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(json.status).toBe(200);
    const zip = await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));
    expect(zip.status).toBe(200);
    expect((await runsGET(req(`/api/data-export/runs?orgId=${ORG}`))).status).toBe(200);
    expect((await destinationsGET(req(`/api/data-export/destinations?orgId=${ORG}`))).status).toBe(200);
    // the test route answers for the destination, not for the role
    expect((await destinationTEST(req(`/api/data-export/destinations/none/test?orgId=${ORG}`, { method: "POST" }), params("none"))).status).toBe(404);
  });

  it("the surface is Admin-only (the mirror of /admin/restore), and the page reads the same set", () => {
    expect(adminSurface("data-export")).toMatchObject({ entry: ["Admin"] });
    expect(adminSurface("data-export")!.entry).toEqual(adminSurface("restore")!.entry);
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/data-export/page.tsx"), "utf8");
    expect(page).toContain('const isAuthorized = hasAnyRole(["Admin"]);');
    expect(page).not.toMatch(/hasAnyRole\(\["Admin", "Manager", "DocCtrl"\]\)/);
  });
});

// ─── BKP-8 Done-when 2: private notes ──────────────────────────────────────
//
// Second review fix pass: withholding the notes made every backup lose them
// on restore — the brief's regression rule forbids that, and the trade-off is
// the user's open decision (DEC-44 (A&O P3) §4). Until then they are carried
// as before this package, counted in the manifest and the DATA_EXPORT row;
// the Admin-only gate is the interim mitigation.

describe("BKP-8 Done-when 2 (open) — standalone notes are carried as before, counted, and only an Admin can export", () => {
  const notes = (): Row[] => [
    { id: "n-private", org_id: ORG, body: "my own scratch", created_by: "u-viewer", task_meta: { evidence: [{ path: key("notes/n-private/photo.jpg") }] } },
    { id: "n-doc", org_id: ORG, body: "on a drawing", created_by: "u-viewer", document_id: "doc-1" },
    { id: "n-proj", org_id: ORG, body: "on a project", created_by: "u-viewer", project_id: "proj-1" },
    { id: "n-asset", org_id: ORG, body: "on a pump", created_by: "u-viewer", asset_id: "as-1" },
  ];

  it("every note is exported — the private one too, so a restore brings it back; the backup is complete; the manifest and the DATA_EXPORT row count it", async () => {
    db.rows.notes = notes();
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com", exporterRole: "Admin" });
    expect((env.tables.notes as Row[]).map((n) => n.id).sort()).toEqual(["n-asset", "n-doc", "n-private", "n-proj"]);
    expect(env.manifest.tables.find((t) => t.name === "notes")).toEqual({ name: "notes", rowCount: 4 });
    expect(env.manifest.complete).toBe(true);
    expect(env.manifest.notes[0]).toBe("This document is a complete export of every record this organization owns.");
    expect(env.manifest.notes).toContain(`1 ${PRIVATE_NOTES_CARRIED}`);
    expect(env.manifest).not.toHaveProperty("withheld");
    // the photo only the private note names travels with it, as before
    expect(env.files.map((f) => f.path)).toContain(key("notes/n-private/photo.jpg"));
    expect(audits("DATA_EXPORT")[0].details).toMatchObject({ privateNotes: { carried: 1 } });
    expect(JSON.stringify(env.tables.notes)).toMatch(/my own scratch/);
  });

  it("a workspace with no private note: no count, no extra note", async () => {
    db.rows.notes = notes().slice(1);
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    expect((env.tables.notes as Row[])).toHaveLength(3);
    expect(env.manifest.complete).toBe(true);
    expect(env.manifest.notes.join(" ")).not.toContain(PRIVATE_NOTES_CARRIED);
    expect(audits("DATA_EXPORT")[0].details).not.toHaveProperty("privateNotes");
  });

  it("the rule is RLS's: no document, project or asset", () => {
    expect(isPrivateNote({ document_id: null, project_id: null, asset_id: null })).toBe(true);
    expect(isPrivateNote({})).toBe(true);
    for (const c of ["document_id", "project_id", "asset_id"]) expect(isPrivateNote({ [c]: "x" }), c).toBe(false);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260630_scratchpad_private.sql"), "utf8");
    expect(sql).toMatch(/notes\.document_id IS NULL\s+AND notes\.project_id IS NULL\s+AND notes\.asset_id\s+IS NULL\s+AND notes\.created_by = auth\.uid\(\)/);
  });

  it("the restore plan raises no incompleteness for them, and plans every note for import", async () => {
    db.rows.notes = notes();
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    const plan = planRestore(env as never, { orgId: ORG, orgName: "Acme", members: [{ uid: "u-admin", email: "me@acme.com" }] });
    expect(plan.warnings.join(" ")).not.toMatch(/INCOMPLETE|private note/);
    expect(plan.counts.tables.find((t) => t.name === "notes")).toMatchObject({ rows: 4, willImport: true });
  });

  it("the restore plan is BKP-15's and the deleted route's only: no withheld branch in lib/dataRestore.ts", () => {
    const src = readFileSync(join(process.cwd(), "lib/dataRestore.ts"), "utf8");
    expect(src).not.toMatch(/withheld/i);
  });
});

// ─── BKP-8 Done-when 3 + BKP-13 Done-when 1: the record ────────────────────

describe("BKP-8 Done-when 3 / BKP-13 Done-when 1 — the export is recorded, by name, and the record is checked", () => {
  const versions = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
    id: `v-${String(i).padStart(4, "0")}`, org_id: ORG, record_id: `doc-${i % 7}`, revision_label: "A",
    file_url: key(`libraries/lib-1/D-${i}.pdf`), size: 4,
  }));

  it("the DATA_EXPORT row names the person, their role and how many download links were minted; DATA_EXPORT_FILES names each file", async () => {
    db.rows.document_versions = versions(3);
    db.rows.document_versions[0].source_file_key = key("libraries/lib-1/D-0.dwg");
    db.rows.asset_photos = [{ id: "ap-1", org_id: ORG, asset_id: "as-1", file_url: key("assets/as-1/1.jpg"), file_size: 4 }];
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(200);
    const row = audits("DATA_EXPORT")[0];
    expect(row).toMatchObject({ org_id: ORG, user_id: "u-admin", user_email: "me@acme.com", user_role: "Admin" });
    expect(row.details).toMatchObject({ channel: "json", exporterRoles: ["Admin"], fileCount: 5, presignedUrls: 5, fileRecordRows: 1 });
    const files = audits("DATA_EXPORT_FILES");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ user_id: "u-admin", user_role: "Admin", details: { part: 1, parts: 1 } });
    const listed = (files[0].details as { files: Row[] }).files;
    expect(listed).toContainEqual({ path: key("libraries/lib-1/D-0.pdf"), documentId: "doc-0", versionId: "v-0000" });
    expect(listed).toContainEqual({ path: key("libraries/lib-1/D-0.dwg"), documentId: "doc-0", versionId: "v-0000" });
    expect(listed).toContainEqual({ path: key("assets/as-1/1.jpg") });
    expect(listed).toHaveLength(5);
  });

  it(`a large export is named ${EXPORT_FILES_PER_AUDIT_ROW} files to a row, every file once, in a handful of statements`, async () => {
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW * 2 + 1);
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    const files = audits("DATA_EXPORT_FILES");
    expect(files.map((f) => (f.details as { part: number }).part)).toEqual([1, 2, 3]);
    const all = files.flatMap((f) => (f.details as { files: Row[] }).files.map((x) => x.path));
    expect(new Set(all).size).toBe(EXPORT_FILES_PER_AUDIT_ROW * 2 + 1);
    expect(audits("DATA_EXPORT")[0].details).toMatchObject({ fileRecordRows: 3 });
  });

  it("a scheduled push (no person) is a machine row: user_id NULL, the machine named — never a string in the uuid column", async () => {
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system", auditDetails: { channel: "scheduled" } });
    expect(audits("DATA_EXPORT")[0]).toMatchObject({ user_id: null, user_email: "system:scheduled-export", user_role: "system", details: { channel: "scheduled" } });
  });

  it("an export whose DATA_EXPORT row is refused is refused itself — nothing is handed out (was: logged nowhere, exported anyway)", async () => {
    db.writeError = (table) => (table === "audit_logs" ? { code: "22P02", message: 'invalid input syntax for type uuid: "cron"' } : null);
    await expect(runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" }))
      .rejects.toThrow(/could not be recorded in the audit trail \(invalid input syntax for type uuid: "cron"\) — it was refused, and nothing was exported/);
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toMatch(/could not be recorded in the audit trail/);
    expect(body).not.toHaveProperty("tables");
  });

  it("a refused file list refuses the export the same way", async () => {
    db.rows.document_versions = versions(2);
    db.writeError = (table, _op, rows) => (table === "audit_logs" && rows[0]?.action === "DATA_EXPORT_FILES" ? { code: "54000", message: "row too big" } : null);
    await expect(runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" }))
      .rejects.toThrow(/list of files this export hands out could not be recorded in the audit trail \(row too big\) — it was refused/);
  });

  it("every export carries the digest of its list, and a person's export names each file under the same record id", async () => {
    db.rows.document_versions = versions(3);
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    const paths = env.files.filter((f) => !!f.presignedUrl).map((f) => f.path);
    const record = (audits("DATA_EXPORT")[0].details as { fileRecord: Record<string, unknown> }).fileRecord;
    expect(record).toMatchObject({ mode: "list", count: 3, sha256: exportFileListDigest(paths) });
    expect(audits("DATA_EXPORT_FILES")[0].details).toMatchObject({ recordId: record.recordId, part: 1, parts: 1 });
    // the digest is of the SORTED list: the archive's own list, in any order, recomputes it
    expect(exportFileListDigest([...paths].reverse())).toBe(exportFileListDigest(paths));
    expect(exportFileListDigest(paths.slice(1))).not.toBe(exportFileListDigest(paths));
  });
});

// ─── BKP-8 Done-when 3, second review fix: a destination push names its files ─
//
// The first review fix recorded a destination push by count and digest only:
// a digest confirms a list but cannot rebuild one, and a webhook's archive is
// on someone else's server, a retention-purged bucket's is gone. Now: a
// webhook push names every file on every run (the list mode); a bucket push
// names them against the destination's last full list — the first push (or
// a change larger than one row) writes a "baseline" naming every file, and a
// later push ONE "delta" row naming what was added and removed since (none
// when nothing changed). The night's list = baseline + delta, and hashes to
// its DATA_EXPORT row's sha256.

describe("BKP-8 Done-when 3 — a destination push names the files that left (DEC-44 (A&O P3) §3)", () => {
  const DEST = "dest-bucket";
  const versions = (n: number, from = 0): Row[] => Array.from({ length: n }, (_, j) => {
    const i = from + j;
    return { id: `v-${String(i).padStart(4, "0")}`, org_id: ORG, record_id: `doc-${i % 7}`, revision_label: "A", file_url: key(`libraries/lib-1/D-${i}.pdf`), size: 4 };
  });
  let night = 0;
  beforeEach(() => {
    night = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => { vi.useRealTimers(); });
  const push = async (destinationId = DEST) => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 5, 0, 0) + night++ * 86_400_000));
    return runOrgExport({
      supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system",
      auditDetails: { channel: "scheduled", destinationId }, fileRecord: { destinationId },
    });
  };
  const lastRecord = () => (audits("DATA_EXPORT").at(-1)!.details as { fileRecord: Record<string, unknown> & { baseline?: { recordId: string } } }).fileRecord;
  const filesOf = (recordId: string) => audits("DATA_EXPORT_FILES").filter((r) => (r.details as { recordId: string }).recordId === recordId).map((r) => r.details as Row & { files: Row[]; removed?: string[] });
  /** What a recall does: rebuild the night's list from the audit trail alone. */
  const rebuild = (record: ReturnType<typeof lastRecord>): Set<string> => {
    if (record.mode === "baseline") return new Set(filesOf(String(record.recordId)).flatMap((d) => d.files.map((f) => String(f.path))));
    const list = new Set(filesOf(record.baseline!.recordId).flatMap((d) => d.files.map((f) => String(f.path))));
    for (const d of filesOf(String(record.recordId))) {
      for (const f of d.files) list.add(String(f.path));
      for (const p of d.removed ?? []) list.delete(p);
    }
    return list;
  };
  const handed = (env: Awaited<ReturnType<typeof push>>) => env.files.filter((f) => !!f.presignedUrl).map((f) => f.path);

  it("the first push to a bucket destination writes a baseline naming every file (500 to a row), with the destination, the document and the revision", async () => {
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW + 1);
    const env = await push();
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "baseline", destinationId: DEST, count: EXPORT_FILES_PER_AUDIT_ROW + 1, sha256: exportFileListDigest(handed(env)) });
    const rows = filesOf(String(record.recordId));
    expect(rows.map((d) => [d.kind, d.destinationId, d.part, d.parts])).toEqual([["baseline", DEST, 1, 2], ["baseline", DEST, 2, 2]]);
    expect(rows[0].files).toContainEqual({ path: key("libraries/lib-1/D-0.pdf"), documentId: "doc-0", versionId: "v-0000" });
    expect(rebuild(record)).toEqual(new Set(handed(env)));
  });

  it("the next night, nothing changed: no file row at all — the record points at the baseline and hashes to the same list", async () => {
    db.rows.document_versions = versions(12);
    await push();
    const before = audits("DATA_EXPORT_FILES").length;
    const env = await push();
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(before);
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "delta", destinationId: DEST, count: 12, added: 0, removed: 0, sha256: exportFileListDigest(handed(env)) });
    expect(rebuild(record)).toEqual(new Set(handed(env)));
  });

  it("a night with new revisions and a deleted one writes ONE delta row naming what was added (document and revision) and what was removed; baseline + delta rebuilds the night's list", async () => {
    db.rows.document_versions = versions(10);
    await push();
    db.rows.document_versions = [...versions(10).slice(1), ...versions(3, 10)];
    const env = await push();
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "delta", added: 3, removed: 1 });
    const [delta] = filesOf(String(record.recordId));
    expect(delta).toMatchObject({ kind: "delta", destinationId: DEST, removed: [key("libraries/lib-1/D-0.pdf")] });
    expect(delta.files).toContainEqual({ path: key("libraries/lib-1/D-11.pdf"), documentId: "doc-4", versionId: "v-0011" });
    expect(delta.files).toHaveLength(3);
    const rebuilt = rebuild(record);
    expect(rebuilt).toEqual(new Set(handed(env)));
    expect(exportFileListDigest([...rebuilt])).toBe(record.sha256);
  });

  it("thirty nightly pushes of a quiet workspace: the baseline once, then thirty DATA_EXPORT rows and no file rows (audit_logs is itself exported)", async () => {
    db.rows.document_versions = versions(1200);
    for (let i = 0; i < 30; i++) await push();
    expect(audits("DATA_EXPORT")).toHaveLength(30);
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(3);
    expect(rebuild(lastRecord()).size).toBe(1200);
  });

  it("a change larger than one row writes a new baseline; the next delta is against it", async () => {
    db.rows.document_versions = versions(5);
    await push();
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW + 10);
    await push();
    const second = lastRecord();
    expect(second).toMatchObject({ mode: "baseline", count: EXPORT_FILES_PER_AUDIT_ROW + 10 });
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW + 11);
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "delta", added: 1, removed: 0, baseline: { recordId: second.recordId } });
    expect(rebuild(lastRecord())).toEqual(new Set(handed(env)));
  });

  it("a baseline that cannot be read back whole (a part gone) is never used: a new full baseline, the problem named", async () => {
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW + 1);
    await push();
    const first = lastRecord();
    db.rows.audit_logs = rowsOf("audit_logs").filter((r) => !(r.action === "DATA_EXPORT_FILES" && (r.details as Row).part === 2));
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "baseline", baselineProblem: expect.stringMatching(new RegExp(`${String(first.recordId)}\\) could not be read back whole: 1 of 2 part`)) });
    expect(rebuild(lastRecord())).toEqual(new Set(handed(env)));
  });

  it("a baseline read that fails writes a full baseline — the export is not refused for it", async () => {
    db.rows.document_versions = versions(4);
    await push();
    db.readError = { audit_logs: "statement timeout" };
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "baseline", baselineProblem: "the last full list could not be read (statement timeout)" });
    expect(handed(env)).toHaveLength(4);
  });

  it("each bucket destination has its own baseline, and a person's export (or a webhook's list) never serves as one", async () => {
    db.rows.document_versions = versions(4);
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    await push("dest-a");
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-a" });
    await push("dest-b");
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-b" });
    await push("dest-a");
    expect(lastRecord()).toMatchObject({ mode: "delta", destinationId: "dest-a", added: 0 });
  });

  it("the server ZIP asks for the list on a webhook push and for the baseline-and-delta record on a bucket push; a ZIP handed to a person names each file", () => {
    const src = readFileSync(join(process.cwd(), "lib/exportRunner.ts"), "utf8");
    expect(src).toMatch(/fileRecord: params\.delivery\.kind === "destination" && params\.delivery\.destination\.destination_type !== "webhook"\s+\? \{ destinationId: params\.delivery\.destination\.id \}\s+: "list",/);
    expect(src).not.toMatch(/"digest"/);
    const structured = readFileSync(join(process.cwd(), "app/api/data-export/structured/route.ts"), "utf8");
    expect(structured).not.toMatch(/fileRecord/); // the JSON download is handed to a person: the default per-file list
  });
});

// ─── BKP-13: the scheduled push is recorded and announced ──────────────────

const sweep = () => scheduledPOST(req("/api/data-export/run-scheduled", { method: "POST", auth: "Bearer cron-secret" }));
const dueDestination = (extra: Row = {}): Row => ({
  id: "dest-1", org_id: ORG, name: "Nightly hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/in",
  enabled: true, next_run_at: "2026-09-30T05:00:00.000Z", schedule_kind: "daily", schedule_hour_utc: 5,
  created_by: "u-admin2", updated_by: "u-admin2", include_files: false, ...extra,
});

describe("BKP-13 — the scheduled push writes its record as a machine and rings the bell", () => {
  it("the builder is asked to record a machine run (user_id null, the machine's label, the destination and its configurer)", async () => {
    db.rows.export_destinations = [dueDestination()];
    const res = await sweep();
    expect(res.status).toBe(200);
    expect(state.delivered).toHaveLength(1);
    expect(state.delivered[0]).toMatchObject({
      orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system",
      auditDetails: { channel: "scheduled", destinationId: "dest-1", destinationType: "webhook", configuredBy: "u-admin2" },
    });
    const src = readFileSync(join(process.cwd(), "app/api/data-export/run-scheduled/route.ts"), "utf8");
    expect(src).not.toMatch(/exporterUserId: "cron"/);
  });

  it("every active controller is told — Admin and DocCtrl by the full collection, no Viewer, no inactive member — naming the destination", async () => {
    db.rows.export_destinations = [dueDestination()];
    await sweep();
    expect(bells().map((b) => b.user_id).sort()).toEqual(["u-admin", "u-admin2", "u-dc"]);
    expect(bells()[0]).toMatchObject({ org_id: ORG, title: "Scheduled workspace export ran", actor_user_id: null, link: "/admin/data-export" });
    expect(String(bells()[0].body)).toMatch(/pushed the entire workspace to "Nightly hook" \(webhook\)/);
    expect(bells()[0].metadata).toMatchObject({ scheduled: true, destinationName: "Nightly hook", configuredBy: "u-admin2" });
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "succeeded", trigger_type: "scheduled" });
  });

  it("a refused alert is recorded on the run, never swallowed — and the run still succeeds", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.writeError = (table) => (table === "notifications" ? { code: "42501", message: "permission denied" } : null);
    await sweep();
    const run = rowsOf("export_runs")[0];
    expect(run.status).toBe("succeeded");
    expect(run.diagnostics).toContainEqual(expect.objectContaining({ step: "alert:unsent", detail: expect.stringMatching(/permission denied/) }));
  });

  it("a run whose record is refused fails — the run row says why, and no bell rings for an export that did not leave", async () => {
    db.rows.export_destinations = [dueDestination()];
    state.deliver = async () => { throw new Error("The export could not be recorded in the audit trail (boom) — it was refused, and nothing was exported."); };
    const res = await sweep();
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/could not be recorded/) });
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "failed", error_message: expect.stringMatching(/could not be recorded/) });
    expect(bells()).toEqual([]);
  });

  it("the manual run tells every OTHER controller, as before", async () => {
    await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));
    expect(bells().map((b) => b.user_id).sort()).toEqual(["u-admin2", "u-dc"]);
    expect(bells()[0]).toMatchObject({ title: "Full workspace export was run", actor_user_id: "u-admin" });
    expect(state.delivered[0]).toMatchObject({ exporterUserId: "u-admin", exporterRole: "Admin", auditDetails: { channel: "zip", exporterRoles: ["Admin"] } });
  });

  it("review fix: the JSON export (the download, and the browser Full ZIP's first step) tells every OTHER controller too", async () => {
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(200);
    expect(bells().map((b) => b.user_id).sort()).toEqual(["u-admin2", "u-dc"]);
    expect(bells()[0]).toMatchObject({ title: "Full workspace export was run", actor_user_id: "u-admin" });
    expect(String(bells()[0].body)).toMatch(/^me@acme\.com exported the entire workspace \(JSON export: a download or the browser-built Full ZIP\)\./);
    expect(res.headers.get("x-export-alert")).toBe("sent to 2");
  });

  it("…a refused alert is logged and named in X-Export-Alert; the download still proceeds", async () => {
    db.writeError = (table) => (table === "notifications" ? { code: "42501", message: "permission denied" } : null);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-export-alert")).toMatch(/^unsent: the alert could not be written \(permission denied\)/);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[data-export\/structured\].*the export alert was not sent/));
    err.mockRestore();
  });

  it("…an export that could not be recorded rings no bell (it did not leave)", async () => {
    db.writeError = (table) => (table === "audit_logs" ? { code: "22P02", message: "bad" } : null);
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(500);
    expect(bells()).toEqual([]);
  });

  it("review fix: a DocCtrl's bell says to ask an Admin and links the audit log it can read; an Admin's links the data-export page", async () => {
    db.rows.export_destinations = [dueDestination()];
    await sweep();
    const admin = bells().find((b) => b.user_id === "u-admin2")!;
    const docCtrl = bells().find((b) => b.user_id === "u-dc")!;
    expect(admin).toMatchObject({ link: ALERT_LINKS.admin });
    expect(String(admin.body)).toMatch(/If you don't recognise this destination, disable it under Admin → Data export\.$/);
    expect(docCtrl).toMatchObject({ link: ALERT_LINKS.other });
    expect(String(docCtrl.body)).toMatch(/ask an Admin to disable it under Admin → Data export\. The run is recorded in the audit log\.$/);
    expect(ALERT_LINKS).toEqual({ admin: "/admin/data-export", other: "/admin/audit" });
    // the two pages the links name admit those readers
    expect(adminSurface("data-export")!.entry).toEqual(["Admin"]);
    expect(adminSurface("audit")!.entry).toContain("DocCtrl");
  });

  it("…and the same split for a person's export and a destination change", async () => {
    await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));
    expect(String(bells().find((b) => b.user_id === "u-dc")!.body)).toMatch(/tell an Admin now so they can review the account\. The export is recorded in the audit log\.$/);
    expect(String(bells().find((b) => b.user_id === "u-admin2")!.body)).toMatch(/review the account immediately\.$/);
    db.rows.notifications = [];
    await destinationsPOST(req("/api/data-export/destinations", {
      method: "POST", body: { orgId: ORG, name: "Hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/x", webhook_secret: "s" },
    }));
    expect(bells().find((b) => b.user_id === "u-dc")).toMatchObject({ link: "/admin/audit" });
    expect(String(bells().find((b) => b.user_id === "u-dc")!.body)).toMatch(/tell an Admin now so they can review it under Admin → Data export\. The change is recorded in the audit log\.$/);
    expect(bells().find((b) => b.user_id === "u-admin2")).toMatchObject({ link: "/admin/data-export" });
  });
});

describe("BKP-13 Done-when 3 — creating, enabling or re-pointing a destination tells every other controller", () => {
  it("creating a webhook destination (no plan gate) rings the other controllers", async () => {
    const res = await destinationsPOST(req("/api/data-export/destinations", {
      method: "POST", body: { orgId: ORG, name: "Hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/x", schedule_kind: "daily", schedule_hour_utc: 5, webhook_secret: "s3cret" },
    }));
    expect(res.status).toBe(200);
    expect(bells().map((b) => b.user_id).sort()).toEqual(["u-admin2", "u-dc"]);
    expect(bells()[0]).toMatchObject({ title: "Export destination created", actor_user_id: "u-admin" });
    expect(String(bells()[0].body)).toMatch(/me@acme\.com created the export destination "Hook" \(webhook\); it pushes the entire workspace daily/);
  });

  it("enabling a disabled destination rings; editing an enabled one's name does not; re-pointing it does", async () => {
    db.rows.export_destinations = [dueDestination({ enabled: false, webhook_secret_encrypted: encryptSecret("s") })];
    const enable = await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, enabled: true } }), params("dest-1"));
    expect(enable.status).toBe(200);
    expect(bells().map((b) => b.title)).toEqual(["Export destination enabled", "Export destination enabled"]);
    db.rows.notifications = [];
    const rename = await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, name: "Renamed", enabled: true } }), params("dest-1"));
    expect(rename.status).toBe(200);
    expect(bells()).toEqual([]);
    const repoint = await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, webhook_url: "https://elsewhere.example.net/in", enabled: true } }), params("dest-1"));
    expect(repoint.status).toBe(200);
    expect(bells().map((b) => b.title)).toEqual(["Export destination changed", "Export destination changed"]);
    expect(String(bells()[0].body)).toMatch(/changed where the export destination "Renamed" \(webhook\) sends the workspace/);
  });
});

// ─── BKP-11 Done-when 3: enabling requires credentials ─────────────────────

describe("BKP-11 Done-when 3 — a destination is enabled only with its credentials", () => {
  const patch = (body: Row) => destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, ...body } }), params("dest-1"));
  // what lib/dataRestore.ts landRestoredRow leaves: disabled, no next run, no credentials
  const restoredWebhook = () => dueDestination({ enabled: false, next_run_at: null, webhook_secret_encrypted: null, access_key_id_encrypted: null, secret_access_key_encrypted: null });
  const restoredBucket = () => ({ ...restoredWebhook(), destination_type: "s3", webhook_url: null, bucket: "their-bucket", endpoint: "https://s3.example.com" });

  it("a restored webhook (no signing secret) is refused 409 on enable, and nothing changes", async () => {
    db.rows.export_destinations = [restoredWebhook()];
    const res = await patch({ enabled: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no signing secret\. Check its URL is yours, enter a signing secret/);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: false, updated_by: "u-admin2" });
    expect(audits("EXPORT_DESTINATION_UPDATED")).toEqual([]);
    expect(bells()).toEqual([]);
  });

  it("…and enabled once the secret is entered in the same save", async () => {
    db.rows.export_destinations = [restoredWebhook()];
    const res = await patch({ enabled: true, webhook_secret: "fresh-secret" });
    expect(res.status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: true });
    expect(String(rowsOf("export_destinations")[0].webhook_secret_encrypted)).not.toBe("");
  });

  it("a restored bucket destination needs both keys: one is not enough", async () => {
    db.rows.export_destinations = [restoredBucket()];
    expect((await patch({ enabled: true })).status).toBe(409);
    expect((await patch({ enabled: true, access_key_id: "AK" })).status).toBe(409);
    expect(rowsOf("export_destinations")[0].enabled).toBe(false);
    const ok = await patch({ enabled: true, access_key_id: "AK", secret_access_key: "SK" });
    expect(ok.status).toBe(200);
    expect(rowsOf("export_destinations")[0].enabled).toBe(true);
  });

  it("no regression: an already-enabled webhook with no secret (the secret is optional) still saves with enabled: true, as the edit form sends it", async () => {
    db.rows.export_destinations = [dueDestination({ webhook_secret_encrypted: null })];
    const res = await patch({ name: "Nightly hook (renamed)", enabled: true, webhook_url: "https://hooks.example.com/in" });
    expect(res.status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ name: "Nightly hook (renamed)", enabled: true });
  });

  it("a destination that does not exist is 404, not a silent no-op", async () => {
    expect((await patch({ enabled: true })).status).toBe(404);
  });

  it("second review fix: `enabled` that is not a JSON boolean is 400 — \"true\" or 1 would be stored as true with no credential check, plan gate or alert", async () => {
    db.rows.export_destinations = [restoredWebhook()];
    for (const enabled of ["true", 1, "on", "t"]) {
      const res = await patch({ enabled });
      expect(res.status, String(enabled)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("enabled must be true or false.");
    }
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: false, updated_by: "u-admin2" });
    expect(audits("EXPORT_DESTINATION_UPDATED")).toEqual([]);
    expect(bells()).toEqual([]);
    // a boolean false still saves
    expect((await patch({ enabled: false, name: "Off" })).status).toBe(200);
  });

  const runNow = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));

  it("review fix: Run Now of a restored webhook (disabled, no secret) is refused 409 — nothing sent, no run row, no bell", async () => {
    db.rows.export_destinations = [restoredWebhook()];
    const res = await runNow();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no signing secret\. Check its URL is yours, enter a signing secret, and run it again/);
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_runs")).toEqual([]);
    expect(bells()).toEqual([]);
  });

  it("…and of a bucket destination without both keys", async () => {
    db.rows.export_destinations = [{ ...restoredBucket(), enabled: true }];
    expect((await runNow()).status).toBe(409);
    expect(state.delivered).toEqual([]);
  });

  it("no regression: Run Now of an enabled secret-less webhook an Admin created here, or of a disabled one that has its secret, still runs", async () => {
    db.rows.export_destinations = [dueDestination({ webhook_secret_encrypted: null })];
    expect((await runNow()).status).toBe(200);
    db.rows.export_destinations = [dueDestination({ enabled: false, webhook_secret_encrypted: encryptSecret("s") })];
    expect((await runNow()).status).toBe(200);
    expect(state.delivered).toHaveLength(2);
  });

  it("review fix: re-pointing an ENABLED destination is held to the rule too — s3 → webhook with no secret is 409, nothing changes", async () => {
    db.rows.export_destinations = [dueDestination({
      destination_type: "s3", webhook_url: null, bucket: "acme", access_key_id_encrypted: encryptSecret("AK"), secret_access_key_encrypted: encryptSecret("SK"),
    })];
    const res = await patch({ destination_type: "webhook", webhook_url: "https://x.example.com/in", enabled: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/enter a signing secret, and save it again/);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ destination_type: "s3", enabled: true });
    expect(bells()).toEqual([]);
    const ok = await patch({ destination_type: "webhook", webhook_url: "https://x.example.com/in", enabled: true, webhook_secret: "fresh" });
    expect(ok.status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ destination_type: "webhook", webhook_url: "https://x.example.com/in" });
  });

  it("…and a new URL for an enabled secret-less webhook needs a secret; the same URL re-sent does not", async () => {
    db.rows.export_destinations = [dueDestination({ webhook_secret_encrypted: null })];
    expect((await patch({ webhook_url: "https://elsewhere.example.net/in", enabled: true })).status).toBe(409);
    expect((await patch({ webhook_url: "https://hooks.example.com/in", enabled: true, name: "Same place" })).status).toBe(200);
  });

  it("the one rule, shared by PATCH and Run Now", () => {
    const none = { accessKey: false, secretKey: false, webhookSecret: false };
    expect(destinationCredentialGap("webhook", none, { requireWebhookSecret: false, then: "x" })).toBeNull();
    expect(destinationCredentialGap("webhook", none, { requireWebhookSecret: true, then: "x" })).toMatch(/no signing secret/);
    expect(destinationCredentialGap("s3", { ...none, accessKey: true }, { requireWebhookSecret: false, then: "x" })).toMatch(/no access key and secret/);
    expect(destinationCredentialGap("r2", { accessKey: true, secretKey: true, webhookSecret: false }, { requireWebhookSecret: true, then: "x" })).toBeNull();
    for (const f of ["app/api/data-export/run/route.ts", "app/api/data-export/destinations/[id]/route.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).toMatch(/destinationCredentialGap\(/);
    }
  });
});

// ─── BILL-3 Done-when 3: a lapsed plan disables a bucket destination ───────

describe("BILL-3 Done-when 3 — a bucket destination whose plan lapsed is disabled (never deleted), and enabling re-checks", () => {
  const bucketDue = () => dueDestination({
    destination_type: "s3", webhook_url: null, bucket: "acme-backups",
    access_key_id_encrypted: encryptSecret("AK"), secret_access_key_encrypted: encryptSecret("SK"),
  });

  it("under SUBSCRIPTION_ENFORCE: skipped, recorded, and DISABLED — the row stays", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [bucketDue()];
    const res = await sweep();
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/plan no longer includes cloud bucket destinations.*the destination was disabled/) });
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_destinations")).toEqual([expect.objectContaining({ id: "dest-1", enabled: false, last_run_status: "failed" })]);
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "cancelled" });
  });

  it("flag off (DEC-18): the would-be skip is a notice; the push runs and nothing is disabled", async () => {
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [bucketDue()];
    await sweep();
    expect(state.delivered).toHaveLength(1);
    expect(rowsOf("export_destinations")[0].enabled).toBe(true);
  });

  it("a departed configurer skips without disabling (not a plan matter)", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    db.rows.export_destinations = [bucketDue()];
    db.rows.export_destinations[0].updated_by = "u-gone";
    await sweep();
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_destinations")[0].enabled).toBe(true);
  });

  it("review fix: …even when the workspace's plan ALSO lapsed — the skip was for the configurer, so nothing is disabled", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [bucketDue()];
    db.rows.export_destinations[0].updated_by = "u-gone";
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0].error).toMatch(/no longer active in this workspace/);
    expect(body.results[0].error).not.toMatch(/the destination was disabled/);
    expect(rowsOf("export_destinations")[0].enabled).toBe(true);
  });

  it("a lapsed SUBSCRIPTION on a plan without buckets is a billing skip too: disabled", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    Object.assign(db.rows.orgs[0], { subscribed_plan: "starter", subscription_status: "canceled" });
    db.rows.export_destinations = [bucketDue()];
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0].error).toMatch(/subscription inactive.*the destination was disabled/);
    expect(rowsOf("export_destinations")[0].enabled).toBe(false);
  });

  const runNowBucket = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));

  it("second review fix: under SUBSCRIPTION_ENFORCE, Run Now of a bucket destination on a plan without buckets is 402 — nothing sent, no run row", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [{ ...bucketDue(), enabled: false }];
    const res = await runNowBucket();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/require the Growth plan/);
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_runs")).toEqual([]);
    db.rows.orgs[0].subscribed_plan = "growth";
    expect((await runNowBucket()).status).toBe(200);
    expect(state.delivered).toHaveLength(1);
  });

  it("…flag off (DEC-18): Run Now of that destination runs as before; a webhook is never plan-gated", async () => {
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [bucketDue()];
    expect((await runNowBucket()).status).toBe(200);
    process.env.SUBSCRIPTION_ENFORCE = "true";
    db.rows.export_destinations = [dueDestination()];
    expect((await runNowBucket()).status).toBe(200);
    expect(state.delivered).toHaveLength(2);
  });

  it("enabling a disabled bucket destination on a lapsed plan is 402, as creating one is", async () => {
    db.rows.orgs[0].subscribed_plan = "starter";
    db.rows.export_destinations = [{ ...bucketDue(), enabled: false }];
    const res = await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, enabled: true } }), params("dest-1"));
    expect(res.status).toBe(402);
    expect(rowsOf("export_destinations")[0].enabled).toBe(false);
    db.rows.orgs[0].subscribed_plan = "growth";
    expect((await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: { orgId: ORG, enabled: true } }), params("dest-1"))).status).toBe(200);
  });
});

// ─── Second review fix: the routes' own reads and writes are checked ───────

describe("second review fix — the export routes check their own rate-limit read, run rows and destination audit rows", () => {
  const run = (body: Row = {}) => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, ...body } }));

  it("a rate-limit count that cannot be read refuses the run (503): nothing is exported (was: read as 0 and let through past the cap)", async () => {
    db.readError = { export_runs: "permission denied for table export_runs" };
    const res = await run();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not check this workspace's export rate limit \(permission denied for table export_runs\) — nothing was run/);
    expect(state.delivered).toEqual([]);
    expect(audits("DATA_EXPORT")).toEqual([]);
  });

  it("the cap still holds: the thirteenth run in an hour is 429", async () => {
    db.rows.export_runs = Array.from({ length: 12 }, (_, i) => ({ id: `r-${i}`, org_id: ORG, started_at: new Date().toISOString(), status: "succeeded" }));
    expect((await run()).status).toBe(429);
    expect(state.delivered).toEqual([]);
  });

  it("a refused run row refuses the run (503): no uncounted export with no run history", async () => {
    db.writeError = (table, op) => (table === "export_runs" && op === "insert" ? { code: "42501", message: "permission denied" } : null);
    const res = await run();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not open this export's run record \(permission denied\) — nothing was exported/);
    expect(state.delivered).toEqual([]);
    expect(bells()).toEqual([]);
  });

  it("a scheduled run whose run row is refused does not export: the result and the destination card say so", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.writeError = (table, op) => (table === "export_runs" && op === "insert" ? { code: "42501", message: "permission denied" } : null);
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/not run: the run record could not be opened \(permission denied\)/) });
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "failed", last_run_error: expect.stringMatching(/run record could not be opened/) });
  });

  it("a scheduled run whose closing writes are refused still succeeded — and the sweep result names what was not recorded", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.writeError = (table, op, rows) => (op === "update" && (
      (table === "export_runs" && rows[0]?.status === "succeeded") || (table === "export_destinations" && rows[0]?.last_run_status === "succeeded")
    ) ? { code: "57014", message: "statement timeout" } : null);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    err.mockRestore();
    expect(body.results[0]).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringMatching(/run row not updated: statement timeout/), expect.stringMatching(/last-run status not recorded: statement timeout/)]) });
  });

  it("a destination change whose audit row is refused is said in the answer (create, edit, delete) — the change stands", async () => {
    db.writeError = (table, _op, rows) => (table === "audit_logs" && String(rows[0]?.action ?? "").startsWith("EXPORT_DESTINATION_") ? { code: "42501", message: "audit refused" } : null);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const created = await destinationsPOST(req("/api/data-export/destinations", {
      method: "POST", body: { orgId: ORG, name: "Hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/x", webhook_secret: "s" },
    }));
    expect(created.status).toBe(200);
    const c = (await created.json()) as { destination: Row; warning?: string };
    expect(c.warning).toMatch(/Created, but the creation could not be recorded in the audit log: audit refused/);
    const id = String(c.destination.id);
    const edited = await destinationPATCH(req(`/api/data-export/destinations/${id}`, { method: "PATCH", body: { orgId: ORG, name: "Hook 2" } }), params(id));
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { warning?: string }).warning).toMatch(/Saved, but the change could not be recorded in the audit log: audit refused/);
    const deleted = await destinationDELETE(req(`/api/data-export/destinations/${id}?orgId=${ORG}`, { method: "DELETE" }), params(id));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, warning: "Deleted, but the deletion could not be recorded in the audit log: audit refused" });
    expect(rowsOf("export_destinations")).toEqual([]);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/EXPORT_DESTINATION_DELETED audit row was not written/));
    err.mockRestore();
  });
});

// ─── BKP-6: retention's outcome on the run row ─────────────────────────────

describe("BKP-6 — a retention purge's failures and real deletion count reach the run row", () => {
  const dest = () => ({
    id: "d", org_id: ORG, destination_type: "s3" as const, bucket: "b", prefix: "backups",
    access_key_id_encrypted: encryptSecret("AK"), secret_access_key_encrypted: encryptSecret("SK"),
  });
  const old = new Date(Date.now() - 90 * 86_400_000);
  const listing = (n: number) => Array.from({ length: n }, (_, i) => ({ Key: `backups/manufacturing-os-export-Acme-${i}.zip`, LastModified: old }));

  it("counts what storage DELETED, not what it chose: a key storage reports in Errors is not deleted", async () => {
    state.s3 = (cmd) => cmd === "ListObjectsV2Command"
      ? { Contents: [...listing(3), { Key: "backups/someone-elses.pdf", LastModified: old }], IsTruncated: false }
      : { Errors: [{ Key: "backups/manufacturing-os-export-Acme-1.zip", Message: "AccessDenied" }] };
    const out = await s3PurgeOlderThan({ dest: dest(), prefix: "backups", keepDays: 30 });
    expect(out).toEqual({ scanned: 4, deleted: 2, failed: 1, error: "storage refused backups/manufacturing-os-export-Acme-1.zip: AccessDenied" });
  });

  it("a delete call that throws stops the purge: the rest count as not deleted", async () => {
    state.s3 = (cmd) => { if (cmd === "ListObjectsV2Command") return { Contents: listing(3), IsTruncated: false }; throw new Error("socket hang up"); };
    expect(await s3PurgeOlderThan({ dest: dest(), prefix: "backups", keepDays: 30 })).toEqual({ scanned: 3, deleted: 0, failed: 3, error: "socket hang up" });
  });

  it("a clean purge is no problem; anything else is one sentence for the run row", () => {
    expect(retentionProblem(undefined)).toBeNull();
    expect(retentionProblem({ keepDays: 30, scanned: 4, deleted: 2, failed: 0 })).toBeNull();
    expect(retentionProblem({ keepDays: 30, scanned: 4, deleted: 2, failed: 1, error: "storage refused x: AccessDenied" }))
      .toBe("Backup delivered and verified, but the retention purge did not finish: deleted 2 archive(s) older than 30 day(s), 1 could not be deleted — storage refused x: AccessDenied.");
    expect(retentionProblem({ keepDays: 7, scanned: 0, deleted: 0, failed: 0, error: "Retention purge refused: no prefix" }))
      .toBe("Backup delivered and verified, but the retention purge did not finish: deleted 0 archive(s) older than 7 day(s) — Retention purge refused: no prefix.");
  });

  it("a scheduled run whose purge failed stays succeeded, with the failure on the run row and the destination card", async () => {
    db.rows.export_destinations = [dueDestination({ destination_type: "s3", webhook_url: null, bucket: "b", prefix: "backups", retention_days: 30 })];
    state.deliver = async () => ({
      bytes: 10, fileCount: 0, tableCount: 1, totalRows: 1, destinationPath: "b/backups/x.zip",
      diagnostics: [{ ts: "t", step: "s3:retention:err", detail: "scanned 4, deleted 2 app archive(s), 1 could not be deleted" }],
      retention: { keepDays: 30, scanned: 4, deleted: 2, failed: 1, error: "storage refused k: AccessDenied" },
    });
    await sweep();
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "succeeded", error_message: expect.stringMatching(/^Backup delivered and verified, but the retention purge did not finish: deleted 2/) });
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "succeeded", last_run_error: expect.stringMatching(/retention purge did not finish/) });
  });

  it("the page asks for a prefix before it takes a retention, says what is deleted, and shows each run's retention outcome", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/data-export/page.tsx"), "utf8");
    expect(page).toContain('<Field label="Prefix" hint="Folder inside the bucket — required for retention">');
    expect(page).toContain('disabled={(type === "webhook" || !prefix.trim()) && retentionDays === ""}');
    expect(page).toMatch(/Set a Prefix first: retention deletes old export archives under that folder, and is refused without one\./);
    expect(page).toMatch(/Deletes this app's export archives \(manufacturing-os-export-….zip\) older than this under/);
    expect(page).toMatch(/d\?\.step === "s3:retention:done" \|\| d\?\.step === "s3:retention:err"/);
    expect(page).toMatch(/Retention: \{retention\.detail\}/);
  });
});
