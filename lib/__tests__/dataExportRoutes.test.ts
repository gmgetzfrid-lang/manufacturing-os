// lib/__tests__/dataExportRoutes.test.ts
//
// admin-and-org Round G, package P3 — the export routes, scheduled exports
// and destination hygiene.
//
//   BKP-8   every /api/data-export route is Admin-only through the one gate
//           (lib/adminGate.ts, the data-export surface); a standalone note —
//           its author's private scratchpad — never leaves in an export; the
//           DATA_EXPORT row names the exporter's role and the files the
//           export hands out are named row by row (DATA_EXPORT_FILES).
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

import { runOrgExport, PRIVATE_NOTES_WITHHELD, EXPORT_FILES_PER_AUDIT_ROW, isPrivateNote } from "@/lib/dataExport";
import { s3PurgeOlderThan, retentionProblem } from "@/lib/exportRunner";
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

describe("BKP-8 Done-when 2 — a standalone note is its author's, and never leaves in an export", () => {
  const notes = (): Row[] => [
    { id: "n-private", org_id: ORG, body: "my own scratch", created_by: "u-viewer", task_meta: { evidence: [{ path: key("notes/n-private/photo.jpg") }] } },
    { id: "n-doc", org_id: ORG, body: "on a drawing", created_by: "u-viewer", document_id: "doc-1" },
    { id: "n-proj", org_id: ORG, body: "on a project", created_by: "u-viewer", project_id: "proj-1" },
    { id: "n-asset", org_id: ORG, body: "on a pump", created_by: "u-viewer", asset_id: "as-1" },
  ];

  it("the private note is withheld, counted and named; every scoped note is exported as before", async () => {
    db.rows.notes = notes();
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com", exporterRole: "Admin" });
    expect((env.tables.notes as Row[]).map((n) => n.id).sort()).toEqual(["n-asset", "n-doc", "n-proj"]);
    expect(env.manifest.tables.find((t) => t.name === "notes")).toEqual({ name: "notes", rowCount: 3 });
    expect(env.manifest.withheld).toEqual({ privateNotes: 1, reason: PRIVATE_NOTES_WITHHELD });
    expect(env.manifest.notes).toContain(`1 ${PRIVATE_NOTES_WITHHELD}`);
    expect(env.manifest.complete).toBe(true);
    // the photo only the private note named is not carried either
    expect(env.files.map((f) => f.path)).not.toContain(key("notes/n-private/photo.jpg"));
    expect(audits("DATA_EXPORT")[0].details).toMatchObject({ withheld: { privateNotes: 1 } });
    expect(JSON.stringify(env)).not.toMatch(/my own scratch/);
  });

  it("a workspace with no private note exports exactly as before (no withheld entry, no extra note)", async () => {
    db.rows.notes = notes().slice(1);
    const env = await runOrgExport({ supabaseUrl: "u", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u-admin", exporterEmail: "me@acme.com" });
    expect((env.tables.notes as Row[])).toHaveLength(3);
    expect(env.manifest.withheld).toBeUndefined();
    expect(env.manifest.notes.join(" ")).not.toContain(PRIVATE_NOTES_WITHHELD);
    expect(audits("DATA_EXPORT")[0].details).not.toHaveProperty("withheld");
  });

  it("the rule is RLS's: no document, project or asset", () => {
    expect(isPrivateNote({ document_id: null, project_id: null, asset_id: null })).toBe(true);
    expect(isPrivateNote({})).toBe(true);
    for (const c of ["document_id", "project_id", "asset_id"]) expect(isPrivateNote({ [c]: "x" }), c).toBe(false);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260630_scratchpad_private.sql"), "utf8");
    expect(sql).toMatch(/notes\.document_id IS NULL\s+AND notes\.project_id IS NULL\s+AND notes\.asset_id\s+IS NULL\s+AND notes\.created_by = auth\.uid\(\)/);
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
