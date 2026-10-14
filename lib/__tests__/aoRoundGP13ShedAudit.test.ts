// admin-and-org Round G, package P13 — ALOG-8's last three sites: the
// space-saver's reclaim (app/api/admin/shed/commit), the ticket archive's
// reclaim (app/api/admin/ticket-shed/commit) and its restore
// (app/api/admin/ticket-shed/restore). Each wrote its audit row inside
// `try { await insert } catch { }` — dead against supabase-js, which resolves
// a refusal into `error` and never throws — so a refused DATA_ARCHIVE_RECLAIM
// / TICKET_ARCHIVE_RECLAIM / TICKET_ARCHIVE_RESTORE row (the only record of
// what was destroyed or put back) vanished with a 200. Now each insert is
// checked, the archive-cancel pattern: the act has happened either way, so
// the answer stays 200 with its counts, carries `auditError`, and the refusal
// is logged. Regression: a recorded row answers exactly as before (no
// auditError key).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import JSZip from "jszip";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  /** `${table}.${op}` → the error that op answers */
  errors: {} as Record<string, { message: string }>,
  /** `${table}.${op}` → throw instead of answering */
  throws: {} as Record<string, string>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  r2Sends: 0,
}));

function chain(table: string) {
  let op = "select";
  let patch: Row | null = null;
  let single = false;
  let countExact = false;
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const result = () => {
    const key = `${table}.${op}`;
    if (state.throws[key]) throw new Error(state.throws[key]);
    const err = state.errors[key] ?? null;
    if (err) return { data: null, error: err, count: null };
    if (op === "insert" || op === "upsert" || op === "delete") return { data: null, error: null, count: null };
    if (op === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null, count: countExact ? hit.length : null };
    }
    const data = rows();
    return { data: single ? (data[0] ?? null) : data, error: null, count: data.length };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        try { return Promise.resolve(result()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); }
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (["insert", "upsert", "delete"].includes(prop)) op = prop;
        if (prop === "update") { op = "update"; patch = args[0] as Row; countExact = (args[1] as { count?: string } | undefined)?.count === "exact"; }
        if (prop === "maybeSingle" || prop === "single") single = true;
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "is") filters.push((r) => (r[String(args[0])] ?? null) === args[1]);
        if (prop === "not") filters.push((r) => (r[String(args[0])] ?? null) !== null);
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const adminClient = { from: (t: string) => chain(t) };

vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: vi.fn(async (_req: Request, orgId: string) => ({
    userId: "u-admin", email: "admin@x.io", orgId, roles: ["Admin"], admittedRole: "Admin", admin: adminClient,
  })),
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => { state.r2Sends++; return { Errors: [] }; }) }, R2_BUCKET: "bucket" }));
vi.mock("@/lib/storageKeyRegistry", () => ({ keysReferencedOutside: vi.fn(async () => []) }));
vi.mock("@/lib/shedKeyGuard", async (orig) => ({
  ...(await orig<typeof import("@/lib/shedKeyGuard")>()),
  sharedLiveKeys: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/archiveCatalog", () => ({ persistReclaimShortfall: vi.fn(async () => ({ ok: true })) }));

import * as shedCommit from "@/app/api/admin/shed/commit/route";
import * as ticketCommit from "@/app/api/admin/ticket-shed/commit/route";
import * as ticketRestore from "@/app/api/admin/ticket-shed/restore/route";

const O1 = "11111111-1111-4111-8111-111111111111";
const post = (path: string, body: Row) => new NextRequest(`http://x${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: O1, ...body }),
});
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as Row);
let logged: string[] = [];

beforeEach(() => {
  state.rows = {}; state.errors = {}; state.throws = {}; state.calls = []; state.r2Sends = 0;
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});

function seedShed() {
  state.rows.archives = [{ org_id: O1, archive_id: "MOS-A1", note: "2 files" }];
  state.rows.document_versions = [
    { id: "v1", org_id: O1, archive_id: "MOS-A1", archived_at: null, record_id: "d1", file_url: `orgs/${O1}/docs/v1.pdf` },
    { id: "v2", org_id: O1, archive_id: "MOS-A1", archived_at: null, record_id: "d2", file_url: `orgs/${O1}/docs/v2.pdf` },
  ];
  state.rows.documents = [{ id: "d1", legal_hold: false }, { id: "d2", legal_hold: false }];
}
function seedTicketShed() {
  state.rows.archives = [{ org_id: O1, archive_id: "MOS-T1", note: "1 ticket" }];
  state.rows.tickets = [{ id: "t1", org_id: O1, archive_id: "MOS-T1", archived_at: null, attachments: [{ url: `orgs/${O1}/tickets/t1/a.pdf`, name: "a.pdf" }], comments: [], history: [], metadata: {} }];
}
async function restoreZip(): Promise<NextRequest> {
  const zip = new JSZip();
  // a foreign ticket (skipped, never written) and an empty manifest: the
  // route reaches its audit row with nothing restored
  zip.file("tickets/t9.json", JSON.stringify({ id: "t9", org_id: "99999999-9999-4999-8999-999999999999" }));
  zip.file("files-manifest.json", "{}");
  const buf = await zip.generateAsync({ type: "uint8array" });
  return new NextRequest(`http://x/api/admin/ticket-shed/restore?orgId=${O1}&confirm=true`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/zip" }, body: buf as unknown as BodyInit,
  });
}

describe("ALOG-8 (P13) — /api/admin/shed/commit: the DATA_ARCHIVE_RECLAIM row is checked", () => {
  it("reproduced: a refused row was answered 200 with nothing said; now the answer carries auditError and it is logged", async () => {
    seedShed();
    state.errors["audit_logs.insert"] = { message: "new row violates check constraint" };
    const res = await shedCommit.POST(post("/api/admin/shed/commit", { archiveId: "MOS-A1", confirm: true }));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body).toMatchObject({ ok: true, reclaimed: 2, keysDeleted: 2 });
    expect(String(body.auditError)).toMatch(/freed 2 file\(s\) but its DATA_ARCHIVE_RECLAIM audit row was not written: new row violates check constraint/);
    expect(logged.some((l) => /\[admin\/shed\/commit\] the DATA_ARCHIVE_RECLAIM audit row was not written/.test(l))).toBe(true);
  });

  it("a thrown insert is caught and said the same way", async () => {
    seedShed();
    state.throws["audit_logs.insert"] = "fetch failed";
    const body = await (await shedCommit.POST(post("/api/admin/shed/commit", { archiveId: "MOS-A1", confirm: true }))).json() as Row;
    expect(String(body.auditError)).toMatch(/fetch failed/);
  });

  it("regression: a recorded reclaim answers exactly as before — no auditError, the row names the archive and counts", async () => {
    seedShed();
    const res = await shedCommit.POST(post("/api/admin/shed/commit", { archiveId: "MOS-A1", confirm: true }));
    const body = await res.json() as Row;
    expect(res.status).toBe(200);
    expect("auditError" in body).toBe(false);
    expect(body).toMatchObject({ ok: true, archiveId: "MOS-A1", reclaimed: 2, keysDeleted: 2, keysFailed: 0, shortfallPersisted: true, errors: [] });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "DATA_ARCHIVE_RECLAIM", resource_type: "org", resource_id: O1, org_id: O1, user_id: "u-admin", user_email: "admin@x.io" });
    expect(logged).toEqual([]);
  });
});

describe("ALOG-8 (P13) — /api/admin/ticket-shed/commit: the TICKET_ARCHIVE_RECLAIM row is checked", () => {
  it("a refused row: 200 with the counts, auditError in the answer, logged", async () => {
    seedTicketShed();
    state.errors["audit_logs.insert"] = { message: "permission denied for table audit_logs" };
    const res = await ticketCommit.POST(post("/api/admin/ticket-shed/commit", { archiveId: "MOS-T1", confirm: true }));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body).toMatchObject({ ok: true, reclaimedTickets: 1, keysDeleted: 1 });
    expect(String(body.auditError)).toMatch(/moved 1 ticket\(s\) to the archive but its TICKET_ARCHIVE_RECLAIM audit row was not written: permission denied/);
    expect(logged.some((l) => /\[admin\/ticket-shed\/commit\] the TICKET_ARCHIVE_RECLAIM audit row was not written/.test(l))).toBe(true);
  });

  it("regression: a recorded reclaim answers as before, no auditError", async () => {
    seedTicketShed();
    const body = await (await ticketCommit.POST(post("/api/admin/ticket-shed/commit", { archiveId: "MOS-T1", confirm: true }))).json() as Row;
    expect("auditError" in body).toBe(false);
    expect(body).toMatchObject({ ok: true, archiveId: "MOS-T1", reclaimedTickets: 1, processed: 1, keysDeleted: 1, keysFailed: 0, errors: [] });
    expect(audits()[0]).toMatchObject({ action: "TICKET_ARCHIVE_RECLAIM", org_id: O1, user_id: "u-admin" });
    expect(logged).toEqual([]);
  });
});

describe("ALOG-8 (P13) — /api/admin/ticket-shed/restore: the TICKET_ARCHIVE_RESTORE row is checked", () => {
  it("a refused row: 200 with the counts, auditError in the answer, logged", async () => {
    state.errors["audit_logs.insert"] = { message: "connection reset" };
    const res = await ticketRestore.POST(await restoreZip());
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body).toMatchObject({ ok: true, restored: 0, skippedForeign: 1 });
    expect(String(body.auditError)).toMatch(/put back 0 ticket\(s\) but its TICKET_ARCHIVE_RESTORE audit row was not written: connection reset/);
    expect(logged.some((l) => /\[admin\/ticket-shed\/restore\] the TICKET_ARCHIVE_RESTORE audit row was not written/.test(l))).toBe(true);
  });

  it("regression: a recorded restore answers as before, no auditError", async () => {
    const body = await (await ticketRestore.POST(await restoreZip())).json() as Row;
    expect("auditError" in body).toBe(false);
    expect(body).toMatchObject({ ok: true, restored: 0, skippedForeign: 1, errors: [] });
    expect(audits()[0]).toMatchObject({ action: "TICKET_ARCHIVE_RESTORE", org_id: O1, user_id: "u-admin" });
  });
});
