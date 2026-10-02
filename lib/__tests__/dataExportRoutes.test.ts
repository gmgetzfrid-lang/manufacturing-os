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
//           role and every file that leaves is named (DATA_EXPORT_FILES)
//           against a ledger — the workspace's for a person's export, the
//           destination's for a push to a bucket or a webhook (a baseline,
//           then each export a delta of its change, chained back to it;
//           machine rows no member can forge), each row's list compact; an
//           export recorded and then not delivered is recorded as
//           undelivered; the JSON export is capped like the manual run, on
//           the runs people started.
//   BKP-13  the scheduled push writes its DATA_EXPORT row as a machine
//           (user_id NULL — DEC-44 (A&O P3)) and the write is CHECKED: an
//           export that cannot be recorded is refused; every export rings the
//           controllers' bell, the scheduled one included; creating or
//           enabling a destination (or re-pointing an enabled one) does too;
//           a destination a non-Admin last confirmed still runs, and its bell
//           asks every Admin to confirm it or disable it.
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
import { readFileSync, promises as fsPromises } from "node:fs";
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

import {
  runOrgExport, PRIVATE_NOTES_CARRIED, EXPORT_FILES_PER_AUDIT_ROW, isPrivateNote, exportFileListDigest,
  fileListEntries, fileListRemoved, readDestinationLedger, DESTINATION_FILES_RESOURCE_TYPE,
  EXPORT_LEDGER_ACTOR, LEDGER_CHAIN_MAX_ROWS, WORKSPACE_FILES_RESOURCE_TYPE, readWorkspaceLedger,
} from "@/lib/dataExport";
import { s3PurgeOlderThan, retentionProblem, destinationCredentialGap, MAX_EXPORT_RUNS_PER_HOUR } from "@/lib/exportRunner";
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
  // audit_logs.timestamp DEFAULT NOW(): the destination baseline read orders by it
  db.defaults = { audit_logs: () => ({ timestamp: new Date().toISOString() }) };
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
    // a person's export: the workspace's ledger (fifth review fix — its first
    // export a baseline), a machine row naming who exported in details; the
    // person and the role the surface admitted are on the DATA_EXPORT row
    expect(files[0]).toMatchObject({
      user_id: null, user_email: EXPORT_LEDGER_ACTOR.email, user_role: "system",
      resource_type: WORKSPACE_FILES_RESOURCE_TYPE, resource_id: ORG,
      details: { kind: "baseline", ledger: "workspace", part: 1, parts: 1, exportedBy: { userId: "u-admin", email: "me@acme.com" } },
    });
    const listed = fileListEntries(files[0].details);
    expect(listed).toContainEqual({ path: key("libraries/lib-1/D-0.pdf"), documentId: "doc-0", versionId: "v-0000" });
    expect(listed).toContainEqual({ path: key("libraries/lib-1/D-0.dwg"), documentId: "doc-0", versionId: "v-0000" });
    expect(listed).toContainEqual({ path: key("assets/as-1/1.jpg") });
    expect(listed).toHaveLength(5);
    // third review fix: compact — paths under the workspace prefix, refs parallel
    const d = files[0].details as { prefix: string; paths: string[]; docs: string[]; refs: unknown[] };
    expect(d.prefix).toBe(`orgs/${ORG}/`);
    expect(d.paths).toContain("libraries/lib-1/D-0.pdf");
    expect(d.refs).toHaveLength(d.paths.length);
    expect(d.refs[d.paths.indexOf("assets/as-1/1.jpg")]).toBeNull();
    expect(d.refs[d.paths.indexOf("libraries/lib-1/D-0.pdf")]).toEqual([d.docs.indexOf("doc-0"), "v-0000"]);
    // each document once, however many of its files the row names (D-0.pdf and D-0.dwg share doc-0)
    expect([...d.docs].sort()).toEqual(["doc-0", "doc-1", "doc-2"]);
    expect(d).not.toHaveProperty("files");
  });

  it("third review fix: an Admin whose headline is Viewer is recorded as the Admin the surface admitted, the collection in details", async () => {
    state.roles = ["Viewer", "Admin"];
    expect((await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`))).status).toBe(200);
    expect(audits("DATA_EXPORT")[0]).toMatchObject({ user_role: "Admin", details: { exporterRoles: ["Viewer", "Admin"] } });
    state.deliver = async (p) => {
      const real = await vi.importActual<typeof import("@/lib/exportRunner")>("@/lib/exportRunner");
      return real.buildAndDeliverExport(p as never);
    };
    expect((await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }))).status).toBe(200);
    expect(state.delivered[0]).toMatchObject({ exporterRole: "Admin", auditDetails: { exporterRoles: ["Viewer", "Admin"] } });
    expect(audits("DATA_EXPORT")[1]).toMatchObject({ user_role: "Admin", details: { channel: "zip" } });
  });

  it("third review fix: a compact row at real key lengths takes well under the 240 bytes a file the object form did", async () => {
    // ~120-character keys, as revisions are stored (library, folder and revision uuids, a file name)
    const uuid = (i: number) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
    db.rows.document_versions = Array.from({ length: EXPORT_FILES_PER_AUDIT_ROW }, (_, i) => ({
      id: uuid(i), org_id: ORG, record_id: uuid(100_000 + (i % 50)), revision_label: "A",
      file_url: key(`libraries/${uuid(7)}/${uuid(200_000 + i)}/P-${i}-Rev-A.pdf`), size: 4,
    }));
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    const [row] = audits("DATA_EXPORT_FILES");
    const perFile = JSON.stringify(row.details).length / EXPORT_FILES_PER_AUDIT_ROW;
    const objectForm = JSON.stringify(fileListEntries(row.details)).length / EXPORT_FILES_PER_AUDIT_ROW;
    expect(objectForm).toBeGreaterThan(240);
    expect(perFile).toBeLessThan(160);
    expect(fileListEntries(row.details)).toHaveLength(EXPORT_FILES_PER_AUDIT_ROW);
  });

  it(`a large export is named ${EXPORT_FILES_PER_AUDIT_ROW} files to a row, every file once, in a handful of statements`, async () => {
    db.rows.document_versions = versions(EXPORT_FILES_PER_AUDIT_ROW * 2 + 1);
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    const files = audits("DATA_EXPORT_FILES");
    expect(files.map((f) => (f.details as { part: number }).part)).toEqual([1, 2, 3]);
    const all = files.flatMap((f) => fileListEntries(f.details).map((x) => x.path));
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
    expect(record).toMatchObject({ mode: "baseline", ledger: "workspace", count: 3, sha256: exportFileListDigest(paths) });
    expect(audits("DATA_EXPORT_FILES")[0].details).toMatchObject({ recordId: record.recordId, part: 1, parts: 1 });
    // the digest is of the SORTED list: the archive's own list, in any order, recomputes it
    expect(exportFileListDigest([...paths].reverse())).toBe(exportFileListDigest(paths));
    expect(exportFileListDigest(paths.slice(1))).not.toBe(exportFileListDigest(paths));
  });
});

// ─── BKP-8 Done-when 3: a destination push names its files ─────────────────
//
// The first review fix recorded a destination push by count and digest only:
// a digest confirms a list but cannot rebuild one. The second named a
// webhook push's every file on every run — but audit_logs is itself exported
// (and read whole by every later export), so a nightly webhook grew every
// later backup without bound. Third review fix: every destination push, a
// bucket or a webhook, scheduled or Run Now, names its files against the
// destination's last full list — the first push (or a change larger than
// one row) writes a "baseline" naming every file, and a later push ONE
// "delta" row naming what was added and removed since (none when nothing
// changed). The night's list = baseline + delta, and hashes to its
// DATA_EXPORT row's sha256. The rows are the destination's (resource_type
// "export_destination", resource_id its id), found by index.
// Fourth review fix: that delta was cumulative and capped at one row, so a
// busy destination re-wrote its whole list every few nights (every night
// at 500+ changes); and any member could insert a matching "baseline" row
// dated 2099 that every later push took as newest. Now each delta names
// only what changed since the PREVIOUS push (as many rows as that takes),
// chained to it (`prev`) and to its baseline (`baselineId`); a new baseline
// is written only once the chain would pass half the list or
// LEDGER_CHAIN_MAX_ROWS rows; and the ledger rows are machine rows
// (user_id NULL) that the ledger alone reads, never later than now.

const nightOf = (n: number) => new Date(Date.UTC(2026, 9, 1, 5, 30, 0) + n * 86_400_000);
const destVersions = (n: number, from = 0): Row[] => Array.from({ length: n }, (_, j) => {
  const i = from + j;
  return { id: `v-${String(i).padStart(4, "0")}`, org_id: ORG, record_id: `doc-${i % 7}`, revision_label: "A", file_url: key(`libraries/lib-1/D-${i}.pdf`), size: 4 };
});
type FileRecord = Record<string, unknown> & { mode: string; recordId: string; sha256: string; baseline?: { recordId: string }; prev?: string };
const exportRecords = () => audits("DATA_EXPORT").map((r) => (r.details as { fileRecord: FileRecord }).fileRecord);
const lastRecord = () => exportRecords().at(-1)!;
const fileRowsOf = (recordId: string) => audits("DATA_EXPORT_FILES").filter((r) => (r.details as { recordId: string }).recordId === recordId);
const fileDetailsOf = (recordId: string) => fileRowsOf(recordId).map((r) => r.details as Row);
const applyRows = (list: Set<string>, recordId: string) => {
  for (const d of fileDetailsOf(recordId)) {
    for (const p of fileListRemoved(d)) list.delete(p);
    for (const f of fileListEntries(d)) list.add(f.path);
  }
  return list;
};
/** A ledger record's list: the baseline's own rows, or the list of the
 *  record it chains from (`prev`) with its own rows applied. */
const listOfRecord = (recordId: string, baselineId: string): Set<string> => {
  if (recordId === baselineId) return applyRows(new Set(), recordId);
  const [first] = fileDetailsOf(recordId);
  expect(first, `ledger record ${recordId}`).toBeDefined();
  expect(first.baselineId).toBe(baselineId);
  return applyRows(listOfRecord(String(first.prev), baselineId), recordId);
};
/** What a recall does: rebuild a night's list from the audit trail alone —
 *  a person's or a baseline's own rows; for a delta, the chain back to its
 *  baseline (each record's `prev`), then its own rows. */
const rebuild = (record: FileRecord): Set<string> => {
  if (record.mode !== "delta") return applyRows(new Set(), record.recordId);
  return applyRows(listOfRecord(String(record.prev), record.baseline!.recordId), record.recordId);
};
/** Every entry (file named, or path removed) the destination ledger rows carry. */
const ledgerEntries = () => audits("DATA_EXPORT_FILES").reduce((s, r) => s + fileListEntries(r.details).length + fileListRemoved(r.details).length, 0);
const ledgerBytes = (rows: Row[] = audits("DATA_EXPORT_FILES")) => rows.reduce((s, r) => s + JSON.stringify(r.details).length, 0);
const handedOut = (env: { files: Array<{ path: string; presignedUrl: string }> }) => env.files.filter((f) => !!f.presignedUrl).map((f) => f.path);

describe("BKP-8 Done-when 3 — a destination push names the files that left (DEC-44 (A&O P3) §3)", () => {
  const DEST = "dest-bucket";
  let night = 0;
  beforeEach(() => {
    night = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => { vi.useRealTimers(); });
  const push = async (destinationId = DEST) => {
    vi.setSystemTime(nightOf(night++));
    return runOrgExport({
      supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system",
      auditDetails: { channel: "scheduled", destinationId }, fileRecord: { destinationId },
    });
  };

  it("the first push to a destination writes a baseline naming every file (500 to a row) — the destination's rows, with the document and the revision", async () => {
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 1);
    const env = await push();
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "baseline", destinationId: DEST, count: EXPORT_FILES_PER_AUDIT_ROW + 1, sha256: exportFileListDigest(handedOut(env)) });
    const rows = fileRowsOf(record.recordId);
    expect(rows.map((r) => [r.resource_type, r.resource_id])).toEqual([[DESTINATION_FILES_RESOURCE_TYPE, DEST], [DESTINATION_FILES_RESOURCE_TYPE, DEST]]);
    expect(rows.map((r) => r.details as Row).map((d) => [d.kind, d.destinationId, d.part, d.parts])).toEqual([["baseline", DEST, 1, 2], ["baseline", DEST, 2, 2]]);
    expect(fileListEntries(rows[0].details)).toContainEqual({ path: key("libraries/lib-1/D-0.pdf"), documentId: "doc-0", versionId: "v-0000" });
    expect(rebuild(record)).toEqual(new Set(handedOut(env)));
    // the DATA_EXPORT row stays the workspace's
    expect(audits("DATA_EXPORT")[0]).toMatchObject({ resource_type: "org", resource_id: ORG });
    // fourth review fix: the ledger rows are machine rows (no member can write one); who pushed is in details
    for (const r of rows) {
      expect(r).toMatchObject({ user_id: null, user_email: EXPORT_LEDGER_ACTOR.email, user_role: "system" });
      expect(r.details).toMatchObject({ exportedBy: { userId: null, email: "system:scheduled-export" } });
    }
  });

  it("the next night, nothing changed: no file row at all — the record points at the baseline and hashes to the same list", async () => {
    db.rows.document_versions = destVersions(12);
    await push();
    const before = audits("DATA_EXPORT_FILES").length;
    const env = await push();
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(before);
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "delta", destinationId: DEST, count: 12, added: 0, removed: 0, sha256: exportFileListDigest(handedOut(env)) });
    expect(rebuild(record)).toEqual(new Set(handedOut(env)));
  });

  it("a night with new revisions and a deleted one writes ONE delta row naming what was added (document and revision) and what was removed; baseline + delta rebuilds the night's list", async () => {
    db.rows.document_versions = destVersions(10);
    await push();
    db.rows.document_versions = [...destVersions(10).slice(1), ...destVersions(3, 10)];
    const env = await push();
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "delta", added: 3, removed: 1 });
    const [delta] = fileDetailsOf(record.recordId);
    expect(delta).toMatchObject({ kind: "delta", destinationId: DEST, prefix: `orgs/${ORG}/`, removed: ["libraries/lib-1/D-0.pdf"] });
    expect(fileListRemoved(delta)).toEqual([key("libraries/lib-1/D-0.pdf")]);
    expect(fileListEntries(delta)).toContainEqual({ path: key("libraries/lib-1/D-11.pdf"), documentId: "doc-4", versionId: "v-0011" });
    expect(fileListEntries(delta)).toHaveLength(3);
    const rebuilt = rebuild(record);
    expect(rebuilt).toEqual(new Set(handedOut(env)));
    expect(exportFileListDigest([...rebuilt])).toBe(record.sha256);
  });

  it("thirty nightly pushes of a quiet workspace: the baseline once, then thirty DATA_EXPORT rows and no file rows (audit_logs is itself exported)", async () => {
    db.rows.document_versions = destVersions(1200);
    for (let i = 0; i < 30; i++) await push();
    expect(audits("DATA_EXPORT")).toHaveLength(30);
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(3);
    expect(rebuild(lastRecord()).size).toBe(1200);
  });

  it("a change past the chain's cap (half the list, at least one row's worth) writes a new baseline; the next delta is against it (the newest baseline, by timestamp)", async () => {
    db.rows.document_versions = destVersions(5);
    await push();
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 10);
    await push();
    const second = lastRecord();
    expect(second).toMatchObject({ mode: "baseline", count: EXPORT_FILES_PER_AUDIT_ROW + 10 });
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 11);
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "delta", added: 1, removed: 0, baseline: { recordId: second.recordId }, prev: second.recordId });
    expect(second).toMatchObject({ rebased: expect.stringMatching(/would name 505 file\(s\) in 2 row\(s\), past the chain's cap of 500/) });
    expect(rebuild(lastRecord())).toEqual(new Set(handedOut(env)));
  });

  it("a baseline that cannot be read back whole (a part gone) is never used: a new full baseline, the problem named", async () => {
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 1);
    await push();
    const first = lastRecord();
    db.rows.audit_logs = rowsOf("audit_logs").filter((r) => !(r.action === "DATA_EXPORT_FILES" && (r.details as Row).part === 2));
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "baseline", baselineProblem: expect.stringMatching(new RegExp(`${first.recordId}\\) could not be read back whole: 1 of 2 part`)) });
    expect(rebuild(lastRecord())).toEqual(new Set(handedOut(env)));
  });

  it("a baseline read that fails writes a full baseline — the export is not refused for it", async () => {
    db.rows.document_versions = destVersions(4);
    await push();
    db.readError = { audit_logs: "statement timeout" };
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "baseline", baselineProblem: "the last full list could not be read (statement timeout)" });
    expect(handedOut(env)).toHaveLength(4);
  });

  it("each destination has its own baseline, and a person's export never serves as one", async () => {
    db.rows.document_versions = destVersions(4);
    await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    await push("dest-a");
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-a" });
    await push("dest-b");
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-b" });
    await push("dest-a");
    expect(lastRecord()).toMatchObject({ mode: "delta", destinationId: "dest-a", added: 0 });
  });

  it("the baseline is found through the destination's own rows, newest first: a row merely NAMING the destination in its details is not one", async () => {
    db.rows.document_versions = destVersions(4);
    // a workspace-scoped row whose details say "baseline of dest-a" (a forged or legacy row): never read
    db.rows.audit_logs.push({
      action: "DATA_EXPORT_FILES", org_id: ORG, resource_type: "org", resource_id: ORG, timestamp: nightOf(-1).toISOString(),
      details: { kind: "baseline", destinationId: "dest-a", recordId: "forged", sha256: exportFileListDigest([]), startedAt: "x", part: 1, parts: 1, prefix: "", paths: [], refs: [] },
    });
    await push("dest-a");
    expect(lastRecord()).toMatchObject({ mode: "baseline" });
    expect(lastRecord()).not.toHaveProperty("baselineProblem");
  });

  it("the reads ask by resource, machine rows only, never later than now, newest first: the head read four small fields, the parts by page up to `parts`, the chain by its baseline", async () => {
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 1);
    await push("dest-a");
    const mem = await import("./helpers/restoreMemoryDb");
    const calls: Array<{ m: string; args: unknown[] }[]> = [];
    const recording = {
      from: (t: string) => {
        const log: { m: string; args: unknown[] }[] = [];
        calls.push(log);
        const inner = mem.from(t) as Record<string, (...a: unknown[]) => unknown>;
        const proxy: Record<string, unknown> = new Proxy({}, {
          get: (_o, p: string) => (p === "then"
            ? (res: (v: unknown) => void, rej: (e: unknown) => void) => (inner.then as unknown as (a: unknown, b: unknown) => void)(res, rej)
            : (...a: unknown[]) => { log.push({ m: p, args: a }); inner[p](...a); return proxy; }),
        });
        return proxy;
      },
    };
    const out = await readDestinationLedger(recording as never, ORG, "dest-a");
    expect(out.ledger?.paths.size).toBe(EXPORT_FILES_PER_AUDIT_ROW + 1);
    expect(out.ledger).toMatchObject({ links: 0, entries: 0, rows: 0 });
    expect(out.ledger!.head.recordId).toBe(out.ledger!.baseline.recordId);
    expect(calls).toHaveLength(3);
    for (const log of calls) {
      expect(log).toContainEqual({ m: "eq", args: ["resource_type", "export_destination"] });
      expect(log).toContainEqual({ m: "eq", args: ["resource_id", "dest-a"] });
      expect(log).toContainEqual({ m: "eq", args: ["action", "DATA_EXPORT_FILES"] });
      expect(log).toContainEqual({ m: "is", args: ["user_id", null] });
      const lte = log.find((c) => c.m === "lte");
      expect(lte?.args[0]).toBe("timestamp");
      expect(Date.parse(String(lte?.args[1])) - Date.now()).toBeLessThanOrEqual(60_000);
      expect(log.some((c) => c.m === "eq" && c.args[0] === "details->>destinationId")).toBe(false);
    }
    const [headRead, partRead, chainRead] = calls;
    expect(headRead.find((c) => c.m === "select")!.args[0]).toBe("recordId:details->>recordId, parts:details->>parts, sha256:details->>sha256, startedAt:details->>startedAt");
    expect(headRead).toContainEqual({ m: "order", args: ["timestamp", { ascending: false }] });
    expect(headRead).toContainEqual({ m: "limit", args: [1] });
    expect(partRead).toContainEqual({ m: "order", args: ["details->>part", { ascending: true }] });
    expect(partRead).toContainEqual({ m: "range", args: [0, 1] });
    expect(chainRead).toContainEqual({ m: "eq", args: ["details->>kind", "delta"] });
    expect(chainRead).toContainEqual({ m: "eq", args: ["details->>baselineId", out.ledger!.baseline.recordId] });
    expect(chainRead).toContainEqual({ m: "order", args: ["timestamp", { ascending: false }] });
    expect(chainRead).toContainEqual({ m: "limit", args: [LEDGER_CHAIN_MAX_ROWS + 100] });
  });
});

// ─── Fourth review fix: the chained ledger, and rows no member can forge ───

describe("BKP-8 Done-when 3 — fourth review fix: each delta is against the previous push, and only the ledger's own rows are read", () => {
  const DEST = "dest-churn";
  let night = 0;
  beforeEach(() => {
    night = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => { vi.useRealTimers(); });
  const push = async (destinationId = DEST) => {
    vi.setSystemTime(nightOf(night++));
    return runOrgExport({
      supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system",
      auditDetails: { channel: "scheduled", destinationId }, fileRecord: { destinationId },
    });
  };

  it("a busy workspace (5,000 files, 200 new a night, thirty nights): every night rebuilds and hashes, and the ledger stays a small multiple of one baseline — at most 3 entries per changed file beyond it (was: a full baseline every 3rd night, ~19x)", async () => {
    db.rows.document_versions = destVersions(5000);
    let changes = 0;
    const modes: string[] = [];
    for (let n = 0; n < 30; n++) {
      if (n > 0) { db.rows.document_versions.push(...destVersions(200, 5000 + (n - 1) * 200)); changes += 200; }
      const env = await push();
      const record = lastRecord();
      modes.push(record.mode);
      const rebuilt = rebuild(record);
      expect(rebuilt, `night ${n}`).toEqual(new Set(handedOut(env)));
      expect(exportFileListDigest([...rebuilt]), `night ${n}`).toBe(record.sha256);
    }
    const firstBaseline = fileRowsOf(exportRecords()[0].recordId);
    // the bound DEC-44 (A&O P3) §3 states: the first baseline, plus at most (1 + 1/0.5) = 3 entries per changed file
    expect(ledgerEntries()).toBeLessThanOrEqual(5000 + 3 * changes);
    // measured: 2 baselines in 30 nights, about 4.2x the first baseline's bytes
    expect(ledgerBytes()).toBeLessThan(ledgerBytes(firstBaseline) * 5);
    // the deltas carry the night's change, not the change since the baseline
    const deltas = exportRecords().filter((r) => r.mode === "delta");
    expect(deltas.length).toBeGreaterThan(20);
    for (const d of deltas) expect(d).toMatchObject({ added: 200, removed: 0 });
    expect(modes.filter((m) => m === "baseline").length).toBeLessThanOrEqual(2);
  }, 120_000);

  it("a night's change larger than one row is one delta over as many rows (500 entries each), chained to the night before; removals chain the same way", async () => {
    db.rows.document_versions = destVersions(3000);
    await push();
    const baseline = lastRecord();
    db.rows.document_versions.push(...destVersions(700, 3000));
    const env1 = await push();
    const first = lastRecord();
    expect(first).toMatchObject({ mode: "delta", added: 700, removed: 0, prev: baseline.recordId, link: 1, baseline: { recordId: baseline.recordId } });
    expect(fileDetailsOf(first.recordId).map((d) => [d.part, d.parts, d.prev, d.baselineId])).toEqual([[1, 2, baseline.recordId, baseline.recordId], [2, 2, baseline.recordId, baseline.recordId]]);
    expect(rebuild(first)).toEqual(new Set(handedOut(env1)));
    db.rows.document_versions = db.rows.document_versions.slice(300);
    const env2 = await push();
    const second = lastRecord();
    // against the night before (300 removed), not the baseline (700 added and 300 removed)
    expect(second).toMatchObject({ mode: "delta", added: 0, removed: 300, prev: first.recordId, link: 2 });
    expect(fileRowsOf(second.recordId)).toHaveLength(1);
    expect(rebuild(second)).toEqual(new Set(handedOut(env2)));
    // a quiet night writes nothing and points at the chain's head
    await push();
    expect(lastRecord()).toMatchObject({ mode: "delta", added: 0, removed: 0, prev: second.recordId, link: 2 });
    expect(rebuild(lastRecord())).toEqual(new Set(handedOut(env2)));
    const ledger = await readDestinationLedger({ from: (await import("./helpers/restoreMemoryDb")).from } as never, ORG, DEST);
    expect(ledger.ledger).toMatchObject({ links: 2, entries: 1000, rows: 3, head: { recordId: second.recordId } });
  });

  it("a chain that cannot be read back whole (a delta's part gone) is never used: a new full baseline, the problem named", async () => {
    db.rows.document_versions = destVersions(3000);
    await push();
    db.rows.document_versions.push(...destVersions(700, 3000));
    await push();
    const delta = lastRecord();
    db.rows.audit_logs = rowsOf("audit_logs").filter((r) => !((r.details as Row).recordId === delta.recordId && (r.details as Row).part === 2));
    const env = await push();
    expect(lastRecord()).toMatchObject({ mode: "baseline", baselineProblem: expect.stringMatching(/the changes since the last full list \(.+\) could not be read back whole/) });
    expect(rebuild(lastRecord())).toEqual(new Set(handedOut(env)));
  });

  it("a trickle re-bases at the chain's row cap, so the next push never reads back more than that", async () => {
    db.rows.document_versions = destVersions(10);
    await push();
    const modes: string[] = [];
    for (let n = 0; n <= LEDGER_CHAIN_MAX_ROWS; n++) {
      db.rows.document_versions.push(...destVersions(1, 100 + n));
      await push();
      modes.push(lastRecord().mode);
    }
    expect(modes.slice(0, LEDGER_CHAIN_MAX_ROWS).every((m) => m === "delta")).toBe(true);
    expect(modes[LEDGER_CHAIN_MAX_ROWS]).toBe("baseline");
    expect(lastRecord()).toMatchObject({ rebased: expect.stringMatching(new RegExp(`in ${LEDGER_CHAIN_MAX_ROWS + 1} row\\(s\\)`)) });
  }, 120_000);

  it("a member's forged 'baseline' (their own uid, as audit_logs_insert lets them write) dated 2099 is never read: five quiet nights write no file row (was: a full baseline every night)", async () => {
    db.rows.document_versions = destVersions(1200);
    await push();
    const real = lastRecord();
    const forged = (extra: Row): Row => ({
      action: "DATA_EXPORT_FILES", org_id: ORG, resource_type: DESTINATION_FILES_RESOURCE_TYPE, resource_id: DEST,
      user_id: "u-dc", user_email: "dc@acme.com", user_role: "Manager", timestamp: "2099-01-01T00:00:00.000Z", ...extra,
    });
    db.rows.audit_logs.push(
      forged({ details: { kind: "baseline", recordId: "forged", sha256: exportFileListDigest([]), startedAt: "x", part: 1, parts: 1, prefix: "", paths: [], docs: [], refs: [] } }),
      // a forged delta on the REAL baseline, removing a drawing from the record
      forged({ details: { kind: "delta", recordId: "forged-delta", baselineId: real.recordId, prev: real.recordId, sha256: "x", part: 1, parts: 1, prefix: `orgs/${ORG}/`, paths: [], docs: [], refs: [], removed: ["libraries/lib-1/D-0.pdf"] } }),
    );
    const before = audits("DATA_EXPORT_FILES").length;
    for (let i = 0; i < 5; i++) {
      const env = await push();
      expect(lastRecord()).toMatchObject({ mode: "delta", added: 0, removed: 0, prev: real.recordId, baseline: { recordId: real.recordId } });
      expect(rebuild(lastRecord())).toEqual(new Set(handedOut(env)));
    }
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(before);
  });

  it("…nor is a machine-looking row dated in the future (past the minute's clock allowance)", async () => {
    db.rows.document_versions = destVersions(1200);
    await push();
    const real = lastRecord();
    db.rows.audit_logs.push({
      action: "DATA_EXPORT_FILES", org_id: ORG, resource_type: DESTINATION_FILES_RESOURCE_TYPE, resource_id: DEST,
      user_id: null, user_email: EXPORT_LEDGER_ACTOR.email, timestamp: "2099-01-01T00:00:00.000Z",
      details: { kind: "baseline", recordId: "future", sha256: exportFileListDigest([]), startedAt: "x", part: 1, parts: 1, prefix: "", paths: [], docs: [], refs: [] },
    });
    const before = audits("DATA_EXPORT_FILES").length;
    await push();
    expect(lastRecord()).toMatchObject({ mode: "delta", added: 0, baseline: { recordId: real.recordId } });
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(before);
  });
});

// ─── Third review fix: the real builder, a webhook destination, thirty nights ─

describe("BKP-8 Done-when 3 — a webhook push through the real builder: one baseline, then at most one delta row a night", () => {
  const HOOK = "https://203.0.113.10/hook"; // a public literal address: no DNS in the guard
  let posts: Array<{ url: string; headers: Record<string, string> }> = [];
  let readdir: { mockRestore: () => void } | null = null;
  beforeEach(async () => {
    posts = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    // the ZIP's bundled migrations (2.7 MB, compressed every run) are not what
    // this test is about: the archive carries schema.sql alone here
    readdir = vi.spyOn(fsPromises, "readdir").mockResolvedValue([] as never);
    const real = await vi.importActual<typeof import("@/lib/exportRunner")>("@/lib/exportRunner");
    state.deliver = (p) => real.buildAndDeliverExport(p as never);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("ok", { status: 200 });
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); readdir?.mockRestore(); readdir = null; });

  it("thirty scheduled nights: every night pushed and recorded; the file rows are one baseline plus at most one delta a night, and each night's list rebuilds and hashes", async () => {
    db.rows.document_versions = destVersions(EXPORT_FILES_PER_AUDIT_ROW + 100);
    db.rows.export_destinations = [dueDestination({ webhook_url: HOOK, next_run_at: nightOf(0).toISOString() })];
    const nightly: Array<{ rows: number; record: FileRecord; expected: Set<string> }> = [];
    for (let n = 0; n < 30; n++) {
      // the workspace moves: a new revision most nights, one taken away on night 12
      if (n > 0 && n % 3 !== 0) db.rows.document_versions.push(...destVersions(1, 1000 + n));
      if (n === 12) db.rows.document_versions.shift();
      vi.setSystemTime(nightOf(n));
      const before = audits("DATA_EXPORT_FILES").length;
      const res = await sweep();
      const body = (await res.json()) as { processed: number; results: Array<Record<string, unknown>> };
      expect(body.results, `night ${n}`).toEqual([expect.objectContaining({ destinationId: "dest-1", ok: true })]);
      const expected = new Set(db.rows.document_versions.map((v) => String(v.file_url)));
      nightly.push({ rows: audits("DATA_EXPORT_FILES").length - before, record: lastRecord(), expected });
    }
    // every night left by the webhook, as a machine, and was recorded
    expect(posts.filter((p) => p.url === HOOK)).toHaveLength(30);
    expect(audits("DATA_EXPORT")).toHaveLength(30);
    expect(audits("DATA_EXPORT").every((r) => r.user_id === null && r.user_email === "system:scheduled-export")).toBe(true);
    // night 0: the baseline (two parts); every later night: a delta, at most one row
    expect(nightly[0]).toMatchObject({ rows: 2, record: { mode: "baseline", destinationId: "dest-1" } });
    for (const [n, x] of nightly.entries()) {
      if (n === 0) continue;
      expect(x.record.mode, `night ${n}`).toBe("delta");
      expect(x.rows, `night ${n}`).toBeLessThanOrEqual(1);
      expect(x.record.baseline!.recordId, `night ${n}`).toBe(nightly[0].record.recordId);
    }
    expect(audits("DATA_EXPORT_FILES").length).toBeLessThanOrEqual(2 + 29);
    // each night's list, rebuilt from the audit trail alone, is that night's files and hashes to its sha256
    for (const [n, x] of nightly.entries()) {
      const rebuilt = rebuild(x.record);
      expect(rebuilt, `night ${n}`).toEqual(x.expected);
      expect(exportFileListDigest([...rebuilt]), `night ${n}`).toBe(x.record.sha256);
    }
    // the destination's rows, not the workspace's
    expect(audits("DATA_EXPORT_FILES").every((r) => r.resource_type === "export_destination" && r.resource_id === "dest-1")).toBe(true);
    // bounded: a delta is one row of at most 500 entries, so thirty nights add a
    // small multiple of one baseline — the second review fix pass wrote a full
    // list every night (thirty baselines)
    const size = (rows: Row[]) => rows.reduce((s, r) => s + JSON.stringify(r.details).length, 0);
    const baselineBytes = size(fileRowsOf(nightly[0].record.recordId));
    expect(size(audits("DATA_EXPORT_FILES"))).toBeLessThan(baselineBytes * 3);
    for (const x of nightly.slice(1)) expect(size(fileRowsOf(x.record.recordId))).toBeLessThan(baselineBytes / 4);
  }, 60_000);

  it("Run Now to a webhook is the same record: a baseline, then a delta (none when nothing changed); a person's ZIP still names each file", async () => {
    db.rows.document_versions = destVersions(6);
    db.rows.export_destinations = [dueDestination({ webhook_url: HOOK })];
    const runNow = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));
    vi.setSystemTime(nightOf(0));
    expect((await runNow()).status).toBe(200);
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-1" });
    expect(audits("DATA_EXPORT").at(-1)).toMatchObject({ user_id: "u-admin", details: { channel: "destination:webhook" } });
    vi.setSystemTime(nightOf(1));
    const filesBefore = audits("DATA_EXPORT_FILES").length;
    expect((await runNow()).status).toBe(200);
    expect(lastRecord()).toMatchObject({ mode: "delta", added: 0, removed: 0 });
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(filesBefore);
    expect(posts.filter((p) => p.url === HOOK)).toHaveLength(2);
    // the inline ZIP handed to the person: the workspace's own ledger (its
    // first export a baseline), never the destination's
    vi.setSystemTime(nightOf(2));
    const zip = await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));
    expect(zip.status).toBe(200);
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "baseline", ledger: "workspace", count: 6 });
    expect(fileRowsOf(record.recordId)).toEqual([expect.objectContaining({ resource_type: WORKSPACE_FILES_RESOURCE_TYPE, resource_id: ORG, user_id: null })]);
    expect(rebuild(record)).toEqual(new Set(db.rows.document_versions.map((v) => String(v.file_url))));
  }, 30_000);
});

// ─── BKP-13: the scheduled push is recorded and announced ──────────────────

const sweep = () => scheduledPOST(req("/api/data-export/run-scheduled", { method: "POST", auth: "Bearer cron-secret" }));
/** The body the page's edit modal sends for a stored destination, unchanged
 *  (app/(protected)/admin/data-export/page.tsx save(): empty fields dropped,
 *  the bucket always sent when it has one, no credential re-entered). */
const editFormBody = (d: Row): Row => JSON.parse(JSON.stringify({
  orgId: ORG, name: d.name, destination_type: d.destination_type, enabled: d.enabled ?? true,
  endpoint: d.endpoint || undefined, region: d.region || "us-east-1", bucket: d.bucket || undefined, prefix: d.prefix || undefined,
  webhook_url: d.webhook_url || undefined, schedule_kind: d.schedule_kind || "manual",
  schedule_hour_utc: d.schedule_kind === "manual" ? null : (d.schedule_hour_utc ?? 5),
  schedule_day_of_week: d.schedule_kind === "weekly" ? (d.schedule_day_of_week ?? 1) : null,
  schedule_day_of_month: d.schedule_kind === "monthly" ? (d.schedule_day_of_month ?? 1) : null,
  include_files: d.include_files ?? true, retention_days: d.retention_days ?? null,
}));
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
    db.rows.export_runs = Array.from({ length: 12 }, (_, i) => ({ id: `r-${i}`, org_id: ORG, trigger_type: "manual", started_at: new Date().toISOString(), status: "succeeded" }));
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

// ─── Third review fix: every read and write the two run routes make is checked ─

describe("third review fix — the run routes check every read and write of their own; fourth: a scheduled push not confirmed by an Admin runs and asks for it", () => {
  const run = (body: Row = {}) => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, ...body } }));
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("a sweep that cannot read what is due fails (500) — it never answers 'processed: 0' for a night it skipped", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.readError = { export_destinations: "canceling statement due to statement timeout" };
    const err = quiet();
    const res = await sweep();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not read the destinations due for export \(canceling statement due to statement timeout\) — nothing was run/);
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_runs")).toEqual([]);
  });

  it("a refused claim runs nothing and leaves the destination due for the next sweep", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.writeError = (table, op, rows) => (table === "export_destinations" && op === "update" && Object.keys(rows[0] ?? {}).join() === "next_run_at"
      ? { code: "40001", message: "could not serialize access" } : null);
    const err = quiet();
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    err.mockRestore();
    expect(body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^not run: the destination could not be claimed \(could not serialize access\); it stays due for the next sweep$/) });
    expect(state.delivered).toEqual([]);
    expect(rowsOf("export_destinations")[0].next_run_at).toBe("2026-09-30T05:00:00.000Z");
  });

  it("a failed scheduled export whose closing writes are refused names them on the result", async () => {
    db.rows.export_destinations = [dueDestination()];
    state.deliver = async () => { throw new Error("Webhook 502: bad gateway"); };
    db.writeError = (table, op, rows) => (op === "update" && rows[0]?.status !== "running" && (
      (table === "export_runs" && rows[0]?.status === "failed") || (table === "export_destinations" && rows[0]?.last_run_status === "failed")
    ) ? { code: "57014", message: "statement timeout" } : null);
    const err = quiet();
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[run-scheduled\] destination dest-1: run row not updated: statement timeout/));
    err.mockRestore();
    expect(body.results[0]).toMatchObject({ ok: false, error: "Webhook 502: bad gateway; run row not updated: statement timeout; last-run status not recorded: statement timeout" });
  });

  it("Run Now to a destination: refused closing writes come back as warnings (the export left and is recorded)", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.writeError = (table, op, rows) => (op === "update" && (
      (table === "export_runs" && rows[0]?.status === "succeeded") || (table === "export_destinations" && rows[0]?.last_run_status === "succeeded")
    ) ? { code: "57014", message: "statement timeout" } : null);
    const err = quiet();
    const res = await run({ destinationId: "dest-1" });
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, warnings: ["run row not updated: statement timeout", "last-run status not recorded: statement timeout"] });
  });

  it("the downloaded ZIP: a refused run-row update or catalog entry is named in X-Export-Unrecorded; the download proceeds", async () => {
    db.writeError = (table, op, rows) => ((table === "export_runs" && op === "update" && rows[0]?.status === "succeeded") || (table === "archives" && op === "insert")
      ? { code: "42501", message: "permission denied" } : null);
    const err = quiet();
    const res = await run();
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-export-unrecorded")).toBe("run row not updated: permission denied; archive catalog entry not recorded: permission denied");
    // a clean run carries no such header
    db.writeError = null;
    expect((await run()).headers.get("x-export-unrecorded")).toBeNull();
  });

  it("a failed manual run whose closing writes are refused says so with its error — never a run left 'running' in silence", async () => {
    db.rows.export_destinations = [dueDestination()];
    state.deliver = async () => { throw new Error("Webhook 500: down"); };
    db.writeError = (table, op, rows) => (op === "update" && (
      (table === "export_runs" && rows[0]?.status === "failed") || (table === "export_destinations" && rows[0]?.last_run_status === "failed")
    ) ? { code: "57014", message: "statement timeout" } : null);
    const err = quiet();
    const res = await run({ destinationId: "dest-1" });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[data-export\/run\] org .*: run row not updated: statement timeout/));
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Webhook 500: down", warnings: ["run row not updated: statement timeout", "last-run status not recorded: statement timeout"] });
  });

  it("fourth review fix (regression first): a destination last confirmed by a Manager or DocCtrl (before the surface was Admin-only) still RUNS — and every Admin's bell names who confirmed it and asks them to open and save it, or disable it", async () => {
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    // the nightly backup is delivered, as before this package (was: skipped, 0 delivered, 0 bells)
    expect(body.results[0]).toMatchObject({ ok: true, warnings: [expect.stringMatching(/last confirmed by dc@acme\.com, who does not hold Admin/)] });
    expect(state.delivered).toHaveLength(1);
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "succeeded", diagnostics: expect.arrayContaining([expect.objectContaining({ step: "gate:unconfirmed", detail: expect.stringMatching(/does not hold Admin.*open it and save it to confirm it, or disable it/) })]) });
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: true, last_run_status: "succeeded", last_run_error: expect.stringMatching(/last confirmed by dc@acme\.com, who does not hold Admin/) });
    // every Admin is asked to confirm it; the DocCtrl (here, its configurer) to ask an Admin
    const admins = bells().filter((b) => b.user_id === "u-admin" || b.user_id === "u-admin2");
    expect(admins).toHaveLength(2);
    for (const b of admins) {
      expect(b).toMatchObject({ title: "Scheduled export needs an Admin to confirm it", link: "/admin/data-export", metadata: { unconfirmed: { by: "dc@acme.com", holds: "Admin" }, destinationName: "Nightly hook" } });
      expect(String(b.body)).toBe('A scheduled export pushed the entire workspace to "Nightly hook" (webhook). It was last confirmed by dc@acme.com, who does not hold Admin — which setting up a data export now requires. Open it under Admin → Data export and save it to confirm it, or disable it.');
    }
    expect(String(bells().find((b) => b.user_id === "u-dc")!.body)).toMatch(/Ask an Admin to open it under Admin → Data export and save it to confirm it, or disable it\. The run is recorded in the audit log\.$/);
    // it asks again every night until an Admin saves it (PATCH stamps updated_by); then the bell is the usual one
    db.rows.notifications = [];
    Object.assign(db.rows.export_destinations[0], { next_run_at: "2026-09-30T05:00:00.000Z" });
    await sweep();
    expect(bells().filter((b) => b.title === "Scheduled export needs an Admin to confirm it")).toHaveLength(3);
    // fifth review fix: the Admin's save is the real one — the edit form's body through PATCH
    state.userId = "u-admin2";
    const saved = await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: editFormBody(db.rows.export_destinations[0]) }), params("dest-1"));
    expect(saved.status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ updated_by: "u-admin2" });
    db.rows.notifications = [];
    Object.assign(db.rows.export_destinations[0], { next_run_at: "2026-09-30T05:00:00.000Z" });
    const again = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(again.results[0]).toMatchObject({ ok: true });
    expect(again.results[0]).not.toHaveProperty("warnings");
    expect(state.delivered).toHaveLength(3);
    expect(bells().every((b) => b.title === "Scheduled workspace export ran" && !(b.metadata as Row).unconfirmed)).toBe(true);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_error: null });
  });

  it("…a refused bell for an unconfirmed destination is recorded on the run and named on the sweep result; the backup still left", async () => {
    db.rows.export_destinations = [dueDestination({ updated_by: "u-dc" })];
    db.writeError = (table) => (table === "notifications" ? { code: "42501", message: "permission denied" } : null);
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringMatching(/the export alert was not sent: the alert could not be written \(permission denied\)/)]) });
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "succeeded", diagnostics: expect.arrayContaining([expect.objectContaining({ step: "alert:unsent" })]) });
    expect(state.delivered).toHaveLength(1);
  });

  it("…a role lookup that fails cannot tell, so the push runs and says the check could not be made", async () => {
    db.rows.export_destinations = [dueDestination()];
    let reads = 0;
    // the gate's membership read passes; the role read (the second org_members read) fails
    db.readError = new Proxy({} as Record<string, string>, { get: (_t, k) => (k === "org_members" && [2, 3].includes(++reads) ? "connection reset" : undefined) });
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: true, warnings: [expect.stringMatching(/could not be verified \(connection reset\); the push ran/)] });
    expect(state.delivered).toHaveLength(1);
  });

  it("…the role is read by the full collection: an Admin whose headline is another role still confirms", async () => {
    db.rows.org_members.push({ id: "om-6", org_id: ORG, uid: "u-mixed", email: "m@acme.com", role: "Manager", roles: ["Manager", "Admin"], status: "active" });
    db.rows.export_destinations = [dueDestination({ updated_by: "u-mixed" })];
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: true });
  });
});

// ─── Fourth review fix: the JSON export is capped; every writer records the admitted role; a failed delivery is recorded ─

describe("fourth review fix — the JSON export is held to the hourly cap, with a run row of its own", () => {
  const structured = () => structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));

  it("the thirteenth export in an hour is 429 — the JSON export counts toward the cap the manual run is held to (was: uncapped, each call writing its whole file list)", async () => {
    for (let i = 0; i < 12; i++) expect((await structured()).status, `call ${i + 1}`).toBe(200);
    expect(rowsOf("export_runs")).toHaveLength(12);
    expect(rowsOf("export_runs").every((r) => r.trigger_type === "manual" && r.destination_type === "json" && r.status === "succeeded")).toBe(true);
    const capped = await structured();
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: string }).error).toMatch(/Export rate limit reached \(12\/hour for this workspace\)/);
    expect(audits("DATA_EXPORT")).toHaveLength(12);
    // and the manual run counts the JSON exports
    expect((await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }))).status).toBe(429);
  });

  it("a count that cannot be read, or a run row that is refused, refuses the export (503): nothing exported, nothing recorded", async () => {
    db.readError = { export_runs: "permission denied for table export_runs" };
    const unread = await structured();
    expect(unread.status).toBe(503);
    expect(((await unread.json()) as { error: string }).error).toMatch(/Could not check this workspace's export rate limit/);
    db.readError = {};
    db.writeError = (table, op) => (table === "export_runs" && op === "insert" ? { code: "42501", message: "permission denied" } : null);
    const refused = await structured();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Could not open this export's run record \(permission denied\) — nothing was exported/);
    expect(audits("DATA_EXPORT")).toEqual([]);
    expect(bells()).toEqual([]);
  });

  it("the run row closes with the outcome (counts, bytes, run id); a refused closing write is named in X-Export-Unrecorded and the download proceeds", async () => {
    db.rows.document_versions = destVersions(3);
    const res = await structured();
    expect(res.status).toBe(200);
    const run = rowsOf("export_runs")[0];
    expect(res.headers.get("x-export-run-id")).toBe(run.id);
    expect(run).toMatchObject({ status: "succeeded", triggered_by: "u-admin", file_count: 3, destination_type: "json" });
    expect(Number(run.total_bytes)).toBe((await res.text()).length);
    db.writeError = (table, op) => (table === "export_runs" && op === "update" ? { code: "57014", message: "statement timeout" } : null);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = await structured();
    err.mockRestore();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-export-unrecorded")).toBe("run row not updated: statement timeout");
  });
});

describe("fourth review fix — every data-export writer records the role the surface admitted, not the headline", () => {
  it("an Admin whose headline is Viewer creating, editing, testing and deleting a destination is recorded as Admin on each row", async () => {
    state.roles = ["Viewer", "Admin"];
    const created = await destinationsPOST(req("/api/data-export/destinations", {
      method: "POST", body: { orgId: ORG, name: "Hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/x", webhook_secret: "s" },
    }));
    expect(created.status).toBe(200);
    const id = String(((await created.json()) as { destination: Row }).destination.id);
    expect((await destinationPATCH(req(`/api/data-export/destinations/${id}`, { method: "PATCH", body: { orgId: ORG, name: "Hook 2" } }), params(id))).status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    try {
      expect((await destinationTEST(req(`/api/data-export/destinations/${id}/test?orgId=${ORG}`, { method: "POST" }), params(id))).status).toBe(200);
    } finally { vi.unstubAllGlobals(); }
    expect((await destinationDELETE(req(`/api/data-export/destinations/${id}?orgId=${ORG}`, { method: "DELETE" }), params(id))).status).toBe(200);
    const rows = rowsOf("audit_logs").filter((r) => String(r.action).startsWith("EXPORT_DESTINATION_"));
    expect(rows.map((r) => r.action)).toEqual(["EXPORT_DESTINATION_CREATED", "EXPORT_DESTINATION_UPDATED", "EXPORT_DESTINATION_TEST", "EXPORT_DESTINATION_DELETED"]);
    expect(rows.every((r) => r.user_role === "Admin" && r.user_id === "u-admin")).toBe(true);
  });

  it("the gate carries it: the first of the surface's entry roles held, else the headline", async () => {
    const { admittedRoleFor } = await import("@/lib/adminGate");
    expect(admittedRoleFor({ entry: ["Admin"] }, ["Viewer", "Admin"], "Viewer")).toBe("Admin");
    expect(admittedRoleFor({ entry: ["Admin", "Manager"] }, ["Manager", "Admin"], "Manager")).toBe("Admin");
    expect(admittedRoleFor({ entry: "*" }, ["Viewer"], "Viewer")).toBe("Viewer");
    // no route keeps a copy of its own
    for (const f of ["structured", "run"]) {
      expect(readFileSync(join(process.cwd(), `app/api/data-export/${f}/route.ts`), "utf8")).not.toMatch(/function admittedRole/);
    }
  });
});

describe("fourth review fix — an export recorded as leaving that then did not is recorded as undelivered", () => {
  const HOOK = "https://203.0.113.10/hook";
  let readdir: { mockRestore: () => void } | null = null;
  beforeEach(async () => {
    readdir = vi.spyOn(fsPromises, "readdir").mockResolvedValue([] as never);
    const real = await vi.importActual<typeof import("@/lib/exportRunner")>("@/lib/exportRunner");
    state.deliver = (p) => real.buildAndDeliverExport(p as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); readdir?.mockRestore(); readdir = null; });
  const undelivered = () => audits("DATA_EXPORT_UNDELIVERED");

  it("a scheduled push the webhook refuses (500): the run fails, and a DATA_EXPORT_UNDELIVERED machine row names the export's record and the destination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    db.rows.document_versions = destVersions(4);
    db.rows.export_destinations = [dueDestination({ webhook_url: HOOK })];
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^Webhook 500: down/) });
    expect(rowsOf("export_runs")[0]).toMatchObject({ status: "failed" });
    const record = lastRecord();
    expect(record).toMatchObject({ mode: "baseline", destinationId: "dest-1" });
    expect(undelivered()).toEqual([expect.objectContaining({
      org_id: ORG, user_id: null, user_email: EXPORT_LEDGER_ACTOR.email, resource_type: DESTINATION_FILES_RESOURCE_TYPE, resource_id: "dest-1",
      details: expect.objectContaining({ recordId: record.recordId, destinationId: "dest-1", exportedBy: { userId: null, email: "system:scheduled-export" }, error: expect.stringMatching(/Webhook 500/) }),
    })]);
    expect(bells()).toEqual([]);
  }, 30_000);

  it("Run Now the same; a refused UNDELIVERED row is named in the failure (checked)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    db.rows.export_destinations = [dueDestination({ webhook_url: HOOK })];
    const runNow = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));
    const first = await runNow();
    expect(first.status).toBe(500);
    expect(undelivered()).toEqual([expect.objectContaining({ details: expect.objectContaining({ recordId: lastRecord().recordId, exportedBy: { userId: "u-admin", email: "me@acme.com" } }) })]);
    db.writeError = (table, _op, rows) => (table === "audit_logs" && rows[0]?.action === "DATA_EXPORT_UNDELIVERED" ? { code: "42501", message: "audit refused" } : null);
    const second = await runNow();
    expect(second.status).toBe(500);
    expect(((await second.json()) as { error: string }).error).toMatch(/^Webhook 503: down — and the record that this export did not leave could not be written \(audit refused\)$/);
    expect(rowsOf("export_runs").at(-1)).toMatchObject({ status: "failed", error_message: expect.stringMatching(/could not be written \(audit refused\)/) });
  }, 30_000);

  it("an export refused before its DATA_EXPORT row was written writes no UNDELIVERED row (nothing said it left); one refused after it (its file list) does — the JSON export too", async () => {
    db.rows.document_versions = destVersions(2);
    db.writeError = (table, _op, rows) => (table === "audit_logs" && rows[0]?.action === "DATA_EXPORT" ? { code: "22P02", message: "bad" } : null);
    expect((await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`))).status).toBe(500);
    expect(undelivered()).toEqual([]);
    db.writeError = (table, _op, rows) => (table === "audit_logs" && rows[0]?.action === "DATA_EXPORT_FILES" ? { code: "54000", message: "row too big" } : null);
    const res = await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
    expect(res.status).toBe(500);
    const recordId = (audits("DATA_EXPORT").at(-1)!.details as { fileRecord: { recordId: string } }).fileRecord.recordId;
    expect(undelivered()).toEqual([expect.objectContaining({ resource_type: "org", resource_id: ORG, user_id: null, details: expect.objectContaining({ recordId, error: expect.stringMatching(/row too big/) }) })]);
    expect(rowsOf("export_runs").at(-1)).toMatchObject({ status: "failed" });
    // the manual ZIP through the real builder: the same
    const zip = await runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));
    expect(zip.status).toBe(500);
    expect(undelivered()).toHaveLength(2);
  }, 30_000);
});

// ─── Fifth review fix: a person's export on the workspace's own ledger ─────
//
// The fourth pass bounded the destination ledger, but a person's export —
// the JSON download, the browser-built Full ZIP (whose first step is the
// JSON export) and the manual ZIP — still wrote its whole list (about 150
// bytes a file) on every run: a daily Full ZIP of a 20,000-file workspace
// grew audit_logs, itself exported and read whole by every later export, by
// about 1 GB a year. Now every person's export names its files against the
// workspace's own ledger (resource_type "org_export_ledger", resource_id the
// workspace): the same chained baseline/delta as a destination's, machine
// rows no member can forge; who took the export (and the role the surface
// admitted them by, and the list's sha256) stays on its DATA_EXPORT row.

describe("BKP-8 Done-when 3 — fifth review fix: a person's export names its files against the workspace's ledger, never its whole list every run", () => {
  let slot = 0;
  beforeEach(() => {
    slot = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => { vi.useRealTimers(); });
  // two hours apart: the hourly cap is not what these are about
  const tick = () => vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 8, 0, 0) + 2 * 3600_000 * slot++));
  const personExport = async (userId = "u-admin", email = "me@acme.com") => {
    tick();
    return runOrgExport({
      supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: userId, exporterEmail: email, exporterRole: "Admin",
      auditDetails: { channel: "zip", exporterRoles: ["Admin"] },
    });
  };

  it("thirty JSON exports (the download, and the browser Full ZIP's first step) of a quiet workspace: the baseline once, then thirty DATA_EXPORT rows and no file row (was: every file on every run)", async () => {
    db.rows.document_versions = destVersions(1200);
    for (let i = 0; i < 30; i++) {
      tick();
      expect((await structuredGET(req(`/api/data-export/structured?orgId=${ORG}`))).status, `export ${i + 1}`).toBe(200);
    }
    expect(audits("DATA_EXPORT")).toHaveLength(30);
    // who took each export, and as what, is on its own row
    expect(audits("DATA_EXPORT").every((r) => r.user_id === "u-admin" && r.user_role === "Admin" && (r.details as Row).channel === "json")).toBe(true);
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(3);
    expect(audits("DATA_EXPORT_FILES").every((r) => r.resource_type === WORKSPACE_FILES_RESOURCE_TYPE && r.resource_id === ORG && r.user_id === null)).toBe(true);
    const records = exportRecords();
    expect(records[0]).toMatchObject({ mode: "baseline", ledger: "workspace", count: 1200 });
    for (const r of records.slice(1)) expect(r).toMatchObject({ mode: "delta", ledger: "workspace", added: 0, removed: 0, prev: records[0].recordId });
    expect(rebuild(records.at(-1)!).size).toBe(1200);
    expect(exportFileListDigest([...rebuild(records.at(-1)!)])).toBe(records.at(-1)!.sha256);
  }, 60_000);

  it("a busy workspace (5,000 files, 200 new between exports, thirty person exports): every export rebuilds and hashes, within the destination ledger's bound — at most 3 entries per changed file beyond the first baseline, under 5x its bytes (was: a full list every run)", async () => {
    db.rows.document_versions = destVersions(5000);
    let changes = 0;
    for (let n = 0; n < 30; n++) {
      if (n > 0) { db.rows.document_versions.push(...destVersions(200, 5000 + (n - 1) * 200)); changes += 200; }
      const env = await personExport();
      const record = lastRecord();
      expect(record.ledger, `export ${n}`).toBe("workspace");
      const rebuilt = rebuild(record);
      expect(rebuilt, `export ${n}`).toEqual(new Set(handedOut(env)));
      expect(exportFileListDigest([...rebuilt]), `export ${n}`).toBe(record.sha256);
    }
    const firstBaseline = fileRowsOf(exportRecords()[0].recordId);
    expect(ledgerEntries()).toBeLessThanOrEqual(5000 + 3 * changes);
    expect(ledgerBytes()).toBeLessThan(ledgerBytes(firstBaseline) * 5);
    expect(exportRecords().filter((r) => r.mode === "baseline").length).toBeLessThanOrEqual(2);
    for (const d of exportRecords().filter((r) => r.mode === "delta")) expect(d).toMatchObject({ added: 200, removed: 0 });
  }, 120_000);

  it("who took which drawing: each person's DATA_EXPORT row names them and the role the surface admitted, and its record's list, rebuilt, says whether the drawing was in it", async () => {
    db.rows.document_versions = destVersions(10);
    await personExport("u-admin", "me@acme.com");
    db.rows.document_versions.push(...destVersions(1, 500));
    await personExport("u-admin2", "ann@acme.com");
    await personExport("u-admin", "me@acme.com");
    const drawing = key("libraries/lib-1/D-500.pdf");
    const took = audits("DATA_EXPORT")
      .filter((r) => rebuild((r.details as { fileRecord: FileRecord }).fileRecord).has(drawing))
      .map((r) => [r.user_email, r.user_role]);
    expect(took).toEqual([["ann@acme.com", "Admin"], ["me@acme.com", "Admin"]]);
    // the delta that carried it names it with its document and revision, and who exported
    const second = exportRecords()[1];
    expect(second).toMatchObject({ mode: "delta", ledger: "workspace", added: 1, removed: 0 });
    const [row] = fileDetailsOf(second.recordId);
    expect(fileListEntries(row)).toEqual([{ path: drawing, documentId: "doc-3", versionId: "v-0500" }]);
    expect(row).toMatchObject({ kind: "delta", ledger: "workspace", exportedBy: { userId: "u-admin2", email: "ann@acme.com" } });
  });

  it("the workspace's ledger and a destination's are separate: neither serves as the other's", async () => {
    db.rows.document_versions = destVersions(6);
    await personExport();
    const person = lastRecord();
    tick();
    await runOrgExport({
      supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: null, exporterEmail: "system:scheduled-export", exporterRole: "system",
      auditDetails: { channel: "scheduled" }, fileRecord: { destinationId: "dest-x" },
    });
    expect(lastRecord()).toMatchObject({ mode: "baseline", destinationId: "dest-x" });
    expect(lastRecord()).not.toHaveProperty("ledger");
    await personExport();
    expect(lastRecord()).toMatchObject({ mode: "delta", ledger: "workspace", added: 0, prev: person.recordId });
    const ws = await readWorkspaceLedger({ from: (await import("./helpers/restoreMemoryDb")).from } as never, ORG);
    expect(ws.ledger).toMatchObject({ baseline: { recordId: person.recordId }, links: 0 });
    expect(ws.ledger!.paths.size).toBe(6);
  });

  it("a member's forged workspace 'baseline' (their own uid, as audit_logs_insert lets them write) dated 2099 is never read: quiet exports write no file row", async () => {
    db.rows.document_versions = destVersions(1200);
    await personExport();
    const real = lastRecord();
    db.rows.audit_logs.push({
      action: "DATA_EXPORT_FILES", org_id: ORG, resource_type: WORKSPACE_FILES_RESOURCE_TYPE, resource_id: ORG,
      user_id: "u-dc", user_email: "dc@acme.com", user_role: "Manager", timestamp: "2099-01-01T00:00:00.000Z",
      details: { kind: "baseline", ledger: "workspace", recordId: "forged", sha256: exportFileListDigest([]), startedAt: "x", part: 1, parts: 1, prefix: "", paths: [], docs: [], refs: [] },
    });
    const before = audits("DATA_EXPORT_FILES").length;
    for (let i = 0; i < 3; i++) {
      await personExport();
      expect(lastRecord()).toMatchObject({ mode: "delta", added: 0, removed: 0, baseline: { recordId: real.recordId } });
    }
    expect(audits("DATA_EXPORT_FILES")).toHaveLength(before);
  });
});

// ─── Fifth review fix: an Admin's save confirms a bucket destination ────────

describe("fifth review fix — an Admin's save confirms an unconfirmed bucket destination on any plan (DEC-44 (A&O P3) §1; XEDGE-8 judged against the stored row)", () => {
  const bucketDest = (extra: Row = {}): Row => dueDestination({
    name: "Nightly bucket", destination_type: "s3", webhook_url: null, endpoint: "https://s3.example.com", region: "us-east-1",
    bucket: "plant-backups", prefix: "mos", access_key_id_encrypted: encryptSecret("AK"), secret_access_key_encrypted: encryptSecret("SK"),
    created_by: "u-dc", updated_by: "u-dc", ...extra,
  });
  const save = (body: Row) => destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body }), params("dest-1"));

  for (const plan of ["starter", null]) {
    it(`a ${plan ?? "no-plan"} workspace, SUBSCRIPTION_ENFORCE off: the push runs and asks; the Admin's save is 200 and stamps updated_by (was: 402, so the bell rang forever); the next night's bell is the usual one`, async () => {
      delete process.env.SUBSCRIPTION_ENFORCE;
      Object.assign(db.rows.orgs[0], { subscribed_plan: plan, subscription_status: "active" });
      db.rows.export_destinations = [bucketDest()];
      const night1 = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
      expect(night1.results[0]).toMatchObject({ ok: true });
      expect(bells().filter((b) => b.title === "Scheduled export needs an Admin to confirm it").length).toBeGreaterThan(0);
      // the Admin opens it and saves it, unchanged — the body the edit modal sends (the bucket included)
      state.userId = "u-admin";
      const res = await save(editFormBody(db.rows.export_destinations[0]));
      expect(res.status).toBe(200);
      expect(rowsOf("export_destinations")[0]).toMatchObject({ updated_by: "u-admin", bucket: "plant-backups", enabled: true });
      expect(audits("EXPORT_DESTINATION_UPDATED")).toHaveLength(1);
      db.rows.notifications = [];
      Object.assign(db.rows.export_destinations[0], { next_run_at: "2026-09-30T05:00:00.000Z" });
      const night2 = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
      expect(night2.results[0]).toMatchObject({ ok: true });
      expect(((night2.results[0].warnings ?? []) as string[]).some((w) => /last confirmed by/.test(w))).toBe(false);
      expect(bells().length).toBeGreaterThan(0);
      expect(bells().every((b) => b.title === "Scheduled workspace export ran")).toBe(true);
      expect(String(rowsOf("export_destinations")[0].last_run_error ?? "")).not.toMatch(/last confirmed by/);
      expect(state.delivered).toHaveLength(2);
    });
  }

  it("…pointing it at another bucket, or enabling it, is still the Growth act: 402 on a Starter workspace, and nothing changes", async () => {
    Object.assign(db.rows.orgs[0], { subscribed_plan: "starter", subscription_status: "active" });
    db.rows.export_destinations = [bucketDest()];
    const moved = await save({ ...editFormBody(db.rows.export_destinations[0]), bucket: "elsewhere" });
    expect(moved.status).toBe(402);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ bucket: "plant-backups", updated_by: "u-dc" });
    db.rows.export_destinations = [bucketDest({ enabled: false })];
    const enabled = await save({ ...editFormBody(db.rows.export_destinations[0]), enabled: true });
    expect(enabled.status).toBe(402);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: false, updated_by: "u-dc" });
    // XEDGE-8's own case: a bucket put onto a webhook destination
    db.rows.export_destinations = [dueDestination()];
    expect((await save({ orgId: ORG, bucket: "b" })).status).toBe(402);
    expect(rowsOf("export_destinations")[0]).not.toHaveProperty("bucket");
    expect(audits("EXPORT_DESTINATION_UPDATED")).toEqual([]);
  });
});

// ─── Sixth review fix: the store a bucket push lands in is the gated act ────
//
// The fifth pass judged the bucket's NAME against the stored row, so an
// off-plan workspace could keep the name and change the endpoint, the region
// or the type (r2 -> s3) of an enabled destination, and the next push ran
// against a different store. XEDGE-8: pointing a bucket push anywhere new is
// the act creating one is; the unchanged save that confirms it is not.

describe("sixth review fix — moving a bucket push to another store (type, endpoint or region) is the Growth act; the unchanged save still confirms (XEDGE-8; DEC-44 (A&O P3) §1)", () => {
  const bucketDest = (extra: Row = {}): Row => dueDestination({
    name: "Nightly bucket", destination_type: "r2", webhook_url: null, endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto",
    bucket: "plant-backups", prefix: "mos", access_key_id_encrypted: encryptSecret("AK"), secret_access_key_encrypted: encryptSecret("SK"),
    created_by: "u-dc", updated_by: "u-dc", ...extra,
  });
  const save = (body: Row) => destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body }), params("dest-1"));
  const offPlan = () => Object.assign(db.rows.orgs[0], { subscribed_plan: "starter", subscription_status: "active" });

  it("off plan: an endpoint-only change is 402 and nothing changes — the bucket's name kept (was: 200, the push then ran against another store)", async () => {
    offPlan();
    db.rows.export_destinations = [bucketDest()];
    const res = await save({ orgId: ORG, endpoint: "https://elsewhere.example.net" });
    expect(res.status).toBe(402);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com", updated_by: "u-dc" });
    // the same through the edit form's whole body
    expect((await save({ ...editFormBody(db.rows.export_destinations[0]), endpoint: "https://elsewhere.example.net" })).status).toBe(402);
    expect(audits("EXPORT_DESTINATION_UPDATED")).toEqual([]);
  });

  it("off plan: a type change (r2 -> s3) or a region change, the bucket kept, is 402 and nothing changes", async () => {
    offPlan();
    db.rows.export_destinations = [bucketDest()];
    const retyped = await save({ ...editFormBody(db.rows.export_destinations[0]), destination_type: "s3", endpoint: undefined });
    expect(retyped.status).toBe(402);
    expect((await save({ orgId: ORG, region: "eu-west-1" })).status).toBe(402);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ destination_type: "r2", region: "auto", updated_by: "u-dc" });
    expect(audits("EXPORT_DESTINATION_UPDATED")).toEqual([]);
  });

  it("off plan, SUBSCRIPTION_ENFORCE off: the unchanged save is 200 and confirms it — a stored region, and none stored (the form sends the runner's default)", async () => {
    delete process.env.SUBSCRIPTION_ENFORCE;
    offPlan();
    db.rows.export_destinations = [bucketDest()];
    expect((await save(editFormBody(db.rows.export_destinations[0]))).status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ updated_by: "u-admin", region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com" });
    db.rows.export_destinations = [bucketDest({ destination_type: "s3", endpoint: null, region: null })];
    const body = editFormBody(db.rows.export_destinations[0]);
    expect(body).toMatchObject({ region: "us-east-1" });
    expect(body).not.toHaveProperty("endpoint");
    expect((await save(body)).status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ updated_by: "u-admin" });
  });

  it("off plan: moving it to a webhook (no bucket push) is not refused for the plan — the bucket's name left in the form", async () => {
    offPlan();
    db.rows.export_destinations = [bucketDest()];
    const res = await save({
      ...editFormBody(db.rows.export_destinations[0]), destination_type: "webhook",
      webhook_url: "https://hooks.example.com/in", webhook_secret: "whsec",
    });
    expect(res.status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ destination_type: "webhook", updated_by: "u-admin" });
  });

  it("on plan: an endpoint, region or type change is 200, as before", async () => {
    db.rows.export_destinations = [bucketDest()];
    expect((await save({ ...editFormBody(db.rows.export_destinations[0]), endpoint: "https://elsewhere.example.net" })).status).toBe(200);
    expect((await save({ orgId: ORG, region: "eu-west-1" })).status).toBe(200);
    expect((await save({ orgId: ORG, destination_type: "s3" })).status).toBe(200);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ endpoint: "https://elsewhere.example.net", region: "eu-west-1", destination_type: "s3" });
  });
});

// ─── Fifth review fix: the request to confirm survives a failure and a Run Now ─

describe("fifth review fix — an unconfirmed destination's request to confirm survives a failed push and a Run Now (DEC-44 (A&O P3) §1)", () => {
  const runNow = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));
  const confirmRequest = /It was last confirmed by dc@acme\.com, who does not hold Admin — which setting up a data export now requires\. An Admin should open it and save it to confirm it, or disable it\.$/;

  it("a scheduled push that FAILS carries the request on the run row, on the card after the failure, and on the sweep result (was: the failure only); no bell for an export that did not leave", async () => {
    db.rows.export_destinations = [dueDestination({ updated_by: "u-dc" })];
    state.deliver = async () => { throw new Error("Webhook 500: down"); };
    const body = (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({
      ok: false, error: expect.stringMatching(/^Webhook 500: down; It was last confirmed by dc@acme\.com/),
      warnings: [expect.stringMatching(confirmRequest)],
    });
    expect(rowsOf("export_runs")[0]).toMatchObject({
      status: "failed", error_message: "Webhook 500: down",
      diagnostics: [expect.objectContaining({ step: "gate:unconfirmed", detail: expect.stringMatching(confirmRequest) })],
    });
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "failed", last_run_error: expect.stringMatching(/^Webhook 500: down It was last confirmed by/) });
    expect(String(rowsOf("export_destinations")[0].last_run_error)).toMatch(confirmRequest);
    expect(bells()).toEqual([]);
  });

  it("…a long failure is cut so the request still fits on the card", async () => {
    db.rows.export_destinations = [dueDestination({ updated_by: "u-dc" })];
    state.deliver = async () => { throw new Error(`Webhook 500: ${"x".repeat(900)}`); };
    await sweep();
    const card = String(rowsOf("export_destinations")[0].last_run_error);
    expect(card.length).toBeLessThanOrEqual(500);
    expect(card).toMatch(/^Webhook 500: x+ It was last confirmed by/);
    expect(card).toMatch(confirmRequest);
  });

  it("an Admin's Run Now does not confirm it: the card keeps the request, succeeded or failed; once an Admin has saved it, Run Now leaves the card clean", async () => {
    db.rows.export_destinations = [dueDestination({ updated_by: "u-dc" })];
    const ok = await runNow();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, warnings: [expect.stringMatching(confirmRequest)] });
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "succeeded", updated_by: "u-dc", last_run_error: expect.stringMatching(confirmRequest) });
    state.deliver = async () => { throw new Error("Webhook 500: down"); };
    expect((await runNow()).status).toBe(500);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "failed", last_run_error: expect.stringMatching(/^Webhook 500: down It was last confirmed by/) });
    // the Admin saves it (the edit form, unchanged): Run Now's card is clean again
    state.deliver = null;
    expect((await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: editFormBody(db.rows.export_destinations[0]) }), params("dest-1"))).status).toBe(200);
    const clean = await runNow();
    expect(clean.status).toBe(200);
    expect(await clean.json()).not.toHaveProperty("warnings");
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "succeeded", updated_by: "u-admin", last_run_error: null });
  });
});

// ─── Fifth review fix: a person's cap counts the runs people started ───────

describe("fifth review fix — a person's hourly cap counts the runs people started, never the scheduled pushes or their gate skips", () => {
  const structured = () => structuredGET(req(`/api/data-export/structured?orgId=${ORG}`));
  const zip = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG } }));

  it(`${MAX_EXPORT_RUNS_PER_HOUR}+ scheduled pushes (succeeded or failed) and gate-skipped (cancelled) runs in the hour refuse neither the JSON export nor the manual run (was: 429 for up to an hour)`, async () => {
    const now = new Date().toISOString();
    db.rows.export_runs = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s-${i}`, org_id: ORG, trigger_type: "scheduled", status: i % 2 ? "succeeded" : "failed", started_at: now })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `c-${i}`, org_id: ORG, trigger_type: "scheduled", status: "cancelled", started_at: now })),
    ];
    expect((await structured()).status).toBe(200);
    expect((await zip()).status).toBe(200);
  });

  it(`…${MAX_EXPORT_RUNS_PER_HOUR} person-started runs in the hour do, failed attempts included; a cancelled one is not counted`, async () => {
    const now = new Date().toISOString();
    db.rows.export_runs = Array.from({ length: MAX_EXPORT_RUNS_PER_HOUR }, (_, i) => ({ id: `m-${i}`, org_id: ORG, trigger_type: "manual", status: i < 4 ? "failed" : "succeeded", started_at: now }));
    expect((await structured()).status).toBe(429);
    expect((await zip()).status).toBe(429);
    db.rows.export_runs[0].status = "cancelled";
    expect((await structured()).status).toBe(200);
  });

  it("the count asks for exactly that: the person-started triggers, every status but cancelled", async () => {
    const { exportRateLimitRefusal } = await import("@/lib/exportRunner");
    const calls: Array<{ m: string; args: unknown[] }> = [];
    const chain: Record<string, unknown> = new Proxy({}, {
      get: (_o, m: string) => (m === "then"
        ? (res: (v: unknown) => void) => res({ count: 0, error: null })
        : (...args: unknown[]) => { calls.push({ m, args }); return chain; }),
    });
    expect(await exportRateLimitRefusal({ from: () => chain } as never, ORG)).toBeNull();
    expect(calls).toContainEqual({ m: "in", args: ["trigger_type", ["manual", "api"]] });
    expect(calls).toContainEqual({ m: "in", args: ["status", ["pending", "running", "succeeded", "failed"]] });
    expect(calls).toContainEqual({ m: "eq", args: ["org_id", ORG] });
  });
});

// ─── Fifth review fix: the remaining converted routes check their own reads ─

describe("fifth review fix — the destination test, the destination list and the run history check their own reads and writes", () => {
  const HOOK = "https://203.0.113.10/hook"; // a public literal address: no DNS in the guard
  const test = () => destinationTEST(req(`/api/data-export/destinations/dest-1/test?orgId=${ORG}`, { method: "POST" }), params("dest-1"));

  it("the test route: a failed read is 500 naming it (was: 'Destination not found'); a refused EXPORT_DESTINATION_TEST row comes back as a warning beside the probe's result (was: dropped)", async () => {
    db.rows.export_destinations = [dueDestination({ webhook_url: HOOK })];
    db.readError = { export_destinations: "statement timeout" };
    const failed = await test();
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toBe("Could not read the destination (statement timeout) — nothing was tested.");
    db.readError = {};
    db.writeError = (table, _op, rows) => (table === "audit_logs" && rows[0]?.action === "EXPORT_DESTINATION_TEST" ? { code: "42501", message: "audit refused" } : null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const tested = await test();
      expect(tested.status).toBe(200);
      expect(await tested.json()).toEqual({ ok: true, warning: "Tested, but the test could not be recorded in the audit log: audit refused" });
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/EXPORT_DESTINATION_TEST audit row was not written: audit refused/));
      db.writeError = null;
      expect(await (await test()).json()).toEqual({ ok: true });
    } finally { vi.unstubAllGlobals(); err.mockRestore(); }
    expect(audits("EXPORT_DESTINATION_TEST")).toHaveLength(1);
  });

  it("the destination list: a failed read is 500 naming it — never an empty list an Admin would read as 'no destinations'", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.readError = { export_destinations: "permission denied" };
    const res = await destinationsGET(req(`/api/data-export/destinations?orgId=${ORG}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not read this workspace's export destinations (permission denied)." });
    db.readError = {};
    expect(((await (await destinationsGET(req(`/api/data-export/destinations?orgId=${ORG}`))).json()) as { destinations: Row[] }).destinations).toHaveLength(1);
  });

  it("the run history: a failed read is 500, and so is a failed read of its destinations' names (never '(deleted)')", async () => {
    db.rows.export_destinations = [dueDestination()];
    db.rows.export_runs = [{ id: "r-1", org_id: ORG, destination_id: "dest-1", trigger_type: "manual", status: "succeeded", started_at: new Date().toISOString() }];
    const history = () => runsGET(req(`/api/data-export/runs?orgId=${ORG}`));
    db.readError = { export_runs: "statement timeout" };
    const failed = await history();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Could not read this workspace's export history (statement timeout)." });
    db.readError = { export_destinations: "statement timeout" };
    const names = await history();
    expect(names.status).toBe(500);
    expect(await names.json()).toEqual({ error: "Could not read the destinations of this workspace's export history (statement timeout)." });
    db.readError = {};
    const ok = (await (await history()).json()) as { runs: Row[] };
    expect(ok.runs).toEqual([expect.objectContaining({ id: "r-1", destination_name: "Nightly hook" })]);
  });

  it("the page says a list it could not load, never shows it empty", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/data-export/page.tsx"), "utf8");
    expect(page).toContain("else unread.push(`Export destinations could not be loaded: ${await destRes.text()}`);");
    expect(page).toContain("else unread.push(`Export history could not be loaded: ${await runRes.text()}`);");
    expect(page).toContain('if (unread.length) setError(unread.join(" "));');
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
