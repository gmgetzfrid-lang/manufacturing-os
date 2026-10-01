// /api/transmittal — the external portal.
//
// EGR-1: `items` is browser-written JSONB, so the portal must resolve an
// item's file only within the transmittal's OWN org — both version lookups
// are org-scoped; a cross-org id resolves no file.
//
// document-control Round F wave 2 (P7 TRANSMITTALS):
//   TRX-5 / EGR-8  the file is streamed through the route, never a presigned
//                  URL; a PDF is stamped UNCONTROLLED with the as-issued rev,
//                  the transmittal number and a /verify QR; a non-PDF goes out
//                  through the route, recorded as unstamped.
//   TRX-9          every pull is a download_audits row (user_id NULL,
//                  transmittal_id, the served version_id, source) written
//                  BEFORE the bytes; a refused write refuses the download.
//   TRX-8          the served bytes are verified against the hash recorded at
//                  issue (or on the version row); a mismatch releases nothing.
//   TRX-4          voided / revoked / expired answer distinct 410s on GET and
//                  POST; opens and downloads bump the usage trail.
//   TRX-12         the unpinned label fallback admits published rows created
//                  by the issue time and refuses when ambiguous.
//   TRX-11         a key under another workspace's prefix is never read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";

const state = vi.hoisted(() => ({
  transmittal: null as Record<string, unknown> | null,
  versionRow: null as Record<string, unknown> | null,
  versionRows: [] as Array<Record<string, unknown>>,
  fallbackFilters: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  downloads: [] as Array<Record<string, unknown>>,
  downloadErrors: [] as Array<{ code?: string; message: string } | null>,
  updates: [] as Array<Record<string, unknown>>,
  updateRows: [{ id: "t1" }] as Array<Record<string, unknown>>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  fetchedKeys: [] as string[],
  bytes: new Uint8Array() as Uint8Array,
  contentType: "application/pdf" as string | null,
  stamps: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  let op: "select" | "update" | "insert" = "select";
  let payload: Record<string, unknown> | null = null;
  const c: Record<string, unknown> = {};
  const resolveList = () => {
    if (table === "document_versions") {
      state.fallbackFilters.push({ ...filters });
      const rows = state.versionRows.filter((r) => filters.org_id === (r.org_id ?? null));
      return { data: rows, error: null };
    }
    if (table === "transmittals" && op === "update") {
      state.updates.push({ ...payload!, __filters: { ...filters } });
      return { data: state.updateRows, error: null };
    }
    return { data: [], error: null };
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(resolveList());
      return (...args: unknown[]) => {
        if (prop === "eq" || prop === "lte") filters[`${prop}:${String(args[0])}`] = args[1];
        if (prop === "eq") filters[args[0] as string] = args[1];
        if (prop === "update") { op = "update"; payload = args[0] as Record<string, unknown>; }
        if (prop === "insert") {
          op = "insert";
          const row = args[0] as Record<string, unknown>;
          if (table === "audit_logs") { state.audits.push(row); return Promise.resolve({ error: null }); }
          if (table === "download_audits") {
            state.order.push("download_audits");
            state.downloads.push(row);
            const err = state.downloadErrors.length ? state.downloadErrors.shift()! : null;
            return Promise.resolve({ error: err });
          }
          return Promise.resolve({ error: null });
        }
        if (prop === "maybeSingle") {
          if (table === "transmittals") return Promise.resolve({ data: state.transmittal, error: null });
          if (table === "orgs") return Promise.resolve({ data: { name: "Acme" }, error: null });
          if (table === "org_members") return Promise.resolve({ data: null, error: null });
          const ok = state.versionRow && filters.org_id === (state.versionRow.org_id ?? null);
          return Promise.resolve({ data: ok ? state.versionRow : null, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: Record<string, unknown>) => { state.rpcs.push({ fn, args }); return Promise.resolve({ error: null }); },
  },
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input: { Key: string } }) => {
      state.fetchedKeys.push(cmd.input.Key);
      return { Body: { transformToByteArray: async () => state.bytes }, ContentType: state.contentType };
    }),
  },
  R2_BUCKET: "b",
}));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { input: unknown; constructor(i: unknown) { this.input = i; } } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => { throw new Error("the portal must never presign"); }),
}));
vi.mock("@/lib/stamping", () => ({
  applyStampToPdfDoc: vi.fn(async (_doc: unknown, opts: Record<string, unknown>) => { state.order.push("stamp"); state.stamps.push(opts); }),
}));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "https://app.example.com" }));

import { GET, POST } from "@/app/api/transmittal/route";

const TOKEN = "abcdefabcdefabcdefabcdefabcdefab";
const DOC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function get(file?: string): Promise<Response> {
  const u = new URL("https://app/api/transmittal");
  u.searchParams.set("token", TOKEN);
  if (file) u.searchParams.set("file", file);
  return GET(new NextRequest(u));
}
function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new NextRequest("https://app/api/transmittal", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }));
}

async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  return d.save();
}

beforeEach(async () => {
  state.transmittal = {
    id: "t1", org_id: "orgA", status: "issued", number: "TR-0001",
    issued_at: "2026-09-01T00:00:00Z", recipient_email: "jane@buildco.com",
    items: [{ documentId: DOC, number: "P-101", rev: "3", versionId: VER }],
    created_by: "issuer1",
  };
  state.versionRow = null;
  state.versionRows = [];
  state.fallbackFilters = [];
  state.audits = [];
  state.downloads = [];
  state.downloadErrors = [];
  state.updates = [];
  state.updateRows = [{ id: "t1" }];
  state.rpcs = [];
  state.fetchedKeys = [];
  state.bytes = await pdfBytes();
  state.contentType = "application/pdf";
  state.stamps = [];
  state.order = [];
});

describe("GET /api/transmittal file resolver (EGR-1)", () => {
  it("serves the file when the named version is in the transmittal's org; the audit row attributes the issuer", async () => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.fetchedKeys).toEqual([`orgs/orgA/d/${DOC}.pdf`]);
    expect(state.audits.find((a) => a.action === "TRANSMITTAL_PORTAL_DOWNLOAD")?.user_id).toBe("issuer1");
  });

  it("refuses to resolve a version that belongs to another org (404, no bytes read)", async () => {
    state.versionRow = { file_url: `orgs/orgB/d/${DOC}.pdf`, org_id: "orgB", record_id: DOC };
    const res = await get(DOC);
    expect(res.status).toBe(404);
    expect(state.fetchedKeys).toEqual([]);
  });

  it("rejects a file not listed on the transmittal (403)", async () => {
    const res = await get("99999999-9999-9999-9999-999999999999");
    expect(res.status).toBe(403);
    expect(state.fetchedKeys).toEqual([]);
  });

  it("refuses a pinned version that is not a version of the item's document (404)", async () => {
    state.versionRow = { file_url: "orgs/orgA/d/other.pdf", org_id: "orgA", record_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" };
    const res = await get(DOC);
    expect(res.status).toBe(404);
    expect(state.fetchedKeys).toEqual([]);
  });
});

describe("TRX-5 / EGR-8 — streamed through the route and stamped, never a presigned URL", () => {
  it("a PDF comes back as stamped bytes: UNCONTROLLED, the as-issued rev and transmittal number in the footer, a verify QR bound to the version", async () => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="P-101_Rev3.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...body.slice(0, 4))).toBe("%PDF");
    expect(state.stamps).toHaveLength(1);
    const s = state.stamps[0];
    expect(s.watermarkText).toBe("UNCONTROLLED — TRANSMITTAL COPY");
    expect(String(s.footerNotice)).toContain("P-101 Rev 3 as issued on transmittal TR-0001 (2026-09-01)");
    expect(s.verifyUrl).toBe(`https://app.example.com/verify/${DOC}?v=${VER}`);
  });

  it("a non-PDF goes out unstamped THROUGH the route (its own content type), recorded as unstamped", async () => {
    state.bytes = new TextEncoder().encode("AC1027 not a pdf");
    state.contentType = "application/acad";
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.dwg`, org_id: "orgA", record_id: DOC, revision_label: "3" };
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/acad");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="P-101_Rev3.dwg"');
    expect(state.stamps).toHaveLength(0);
    expect(state.downloads[0].source).toBe("transmittal_portal_unstamped");
  });

  it("the route source signs nothing and returns no URL", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/transmittal/route.ts", "utf8");
    expect(src).not.toMatch(/getSignedUrl/);
    expect(src).not.toMatch(/NextResponse\.json\(\{ url/);
  });
});

describe("TRX-9 — the distribution record is written before the bytes leave", () => {
  beforeEach(() => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
  });

  it("one download_audits row: user_id NULL, transmittal_id, the served version, the recipient's email, source transmittal_portal — after the stamp, before the response", async () => {
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.downloads).toHaveLength(1);
    expect(state.downloads[0]).toMatchObject({
      org_id: "orgA", document_id: DOC, version_id: VER, user_id: null, transmittal_id: "t1",
      user_email: "jane@buildco.com", source: "transmittal_portal",
    });
    expect(state.order).toEqual(["stamp", "download_audits"]);
  });

  it("a refused record write refuses the download (503 unrecorded, no bytes)", async () => {
    state.downloadErrors = [{ code: "42501", message: "permission denied" }];
    const res = await get(DOC);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unrecorded" });
    expect(state.audits.find((a) => a.action === "TRANSMITTAL_PORTAL_DOWNLOAD")).toBeUndefined();
  });

  it("ahead of 20261068 the row is retried once in the older shape, attributed to the issuer", async () => {
    state.downloadErrors = [{ code: "PGRST204", message: "Could not find the 'transmittal_id' column" }, null];
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.downloads).toHaveLength(2);
    expect(state.downloads[1]).toMatchObject({ user_id: "issuer1", version_id: VER });
    expect(state.downloads[1]).not.toHaveProperty("transmittal_id");
  });

  it("a download bumps the usage trail (download)", async () => {
    await get(DOC);
    expect(state.rpcs).toEqual([{ fn: "bump_transmittal_portal_use", args: { p_id: "t1", p_kind: "download" } }]);
  });
});

describe("TRX-8 — the bytes served are the bytes issued", () => {
  beforeEach(() => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
  });

  it("a matching recorded hash serves, and the audit row carries the digest and hashVerified", async () => {
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = sha(state.bytes).toUpperCase();
    const res = await get(DOC);
    expect(res.status).toBe(200);
    const a = state.audits.find((x) => x.action === "TRANSMITTAL_PORTAL_DOWNLOAD")!;
    expect((a.details as Record<string, unknown>).servedSha256).toBe(sha(state.bytes));
    expect((a.details as Record<string, unknown>).hashVerified).toBe(true);
  });

  it("a mismatch releases nothing: 409, no download_audits row, an integrity audit row", async () => {
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = "deadbeef";
    const res = await get(DOC);
    expect(res.status).toBe(409);
    expect(state.downloads).toHaveLength(0);
    expect(state.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_PORTAL_INTEGRITY_REFUSED"]);
  });

  it("an item issued before 20261133 (no fileHash) is verified against the version row's hash", async () => {
    state.versionRow = { ...state.versionRow!, file_hash: "not-the-bytes" };
    const res = await get(DOC);
    expect(res.status).toBe(409);
  });
});

describe("TRX-4 — the link has its own lifecycle", () => {
  it("voided, revoked and expired are distinct 410s on GET", async () => {
    state.transmittal!.status = "voided";
    expect((await get()).status).toBe(410);
    expect(await (await get()).json()).toEqual({ error: "voided" });
    state.transmittal!.status = "issued";
    state.transmittal!.portal_revoked_at = "2026-09-10T00:00:00Z";
    expect(await (await get(DOC)).json()).toEqual({ error: "revoked" });
    state.transmittal!.portal_revoked_at = null;
    state.transmittal!.portal_expires_at = "2026-01-01T00:00:00Z";
    const r = await get();
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: "expired" });
    expect(state.fetchedKeys).toEqual([]);
  });

  it("a revoked or expired link cannot record a receipt (POST 410 with the code)", async () => {
    state.transmittal!.portal_revoked_at = "2026-09-10T00:00:00Z";
    const r1 = await post({ token: TOKEN, name: "Jane" });
    expect(r1.status).toBe(410);
    expect(await r1.json()).toEqual({ error: "revoked" });
    state.transmittal!.portal_revoked_at = null;
    state.transmittal!.portal_expires_at = "2026-01-01T00:00:00Z";
    const r2 = await post({ token: TOKEN, name: "Jane" });
    expect(await r2.json()).toEqual({ error: "expired" });
    expect(state.updates).toHaveLength(0);
  });

  it("opening the portal bumps the usage trail (open) and the snapshot carries the as-sent fields and the expiry", async () => {
    state.transmittal!.portal_expires_at = "2099-01-01T00:00:00Z";
    (state.transmittal!.items as Array<Record<string, unknown>>)[0] = {
      documentId: DOC, number: "P-101", rev: "3", versionId: VER, fileHash: "abc123", statusAsSent: "Issued", effectiveDate: "2026-11-01",
    };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.portalExpiresAt).toBe("2099-01-01T00:00:00Z");
    expect((body.items as Array<Record<string, unknown>>)[0]).toEqual({
      documentId: DOC, number: "P-101", title: null, rev: "3", statusAsSent: "Issued", effectiveDate: "2026-11-01", fileHash: "abc123",
    });
    expect(state.rpcs).toEqual([{ fn: "bump_transmittal_portal_use", args: { p_id: "t1", p_kind: "open" } }]);
  });

  it("a portal receipt records the server-side evidence and is a checked write", async () => {
    const r = await post({ token: TOKEN, name: "Jane", note: "received, distributing" });
    expect(r.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ status: "acknowledged", acknowledged_via: "portal", acknowledged_meta: { ip: "203.0.113.9", note: "received, distributing" } });
    state.updates = []; state.updateRows = [];
    const r2 = await post({ token: TOKEN, name: "Jane" });
    expect(r2.status).toBe(409);
  });
});

describe("TRX-12 — the unpinned label fallback never guesses", () => {
  beforeEach(() => {
    state.transmittal!.items = [{ documentId: DOC, number: "P-101", rev: "C" }];
  });

  it("filters to non-branch rows created by the issue time, in the transmittal's org", async () => {
    state.versionRows = [{ id: "v1", file_url: "orgs/orgA/d/c.pdf", org_id: "orgA", review_state: "approved", is_branch: false }];
    const res = await get(DOC);
    expect(res.status).toBe(200);
    const f = state.fallbackFilters[0];
    expect(f["eq:record_id"]).toBe(DOC);
    expect(f["eq:revision_label"]).toBe("C");
    expect(f["eq:is_branch"]).toBe(false);
    expect(f["lte:created_at"]).toBe("2026-09-01T00:00:00Z");
    expect(state.downloads[0].version_id).toBe("v1");
  });

  it("an in-review or rejected submission is never served", async () => {
    state.versionRows = [{ id: "v2", file_url: "orgs/orgA/d/x.pdf", org_id: "orgA", review_state: "in_review", is_branch: false }];
    expect((await get(DOC)).status).toBe(404);
    state.versionRows = [{ id: "v3", file_url: "orgs/orgA/d/x.pdf", org_id: "orgA", review_state: "rejected", is_branch: false }];
    expect((await get(DOC)).status).toBe(404);
    expect(state.fetchedKeys).toEqual([]);
  });

  it("more than one qualifying row refuses (409) instead of serving the newest", async () => {
    state.versionRows = [
      { id: "v4", file_url: "orgs/orgA/d/c1.pdf", org_id: "orgA", review_state: "approved", is_branch: false },
      { id: "v5", file_url: "orgs/orgA/d/c2.pdf", org_id: "orgA", review_state: null, is_branch: false },
    ];
    const res = await get(DOC);
    expect(res.status).toBe(409);
    expect(state.fetchedKeys).toEqual([]);
  });
});

describe("TRX-11 — a key under another workspace's prefix is never read", () => {
  it("refuses an orgs/<other>/ key (404, no fetch), and an unsafe key", async () => {
    state.versionRow = { file_url: "orgs/orgB/d/stolen.pdf", org_id: "orgA", record_id: DOC };
    expect((await get(DOC)).status).toBe(404);
    state.versionRow = { file_url: "orgs/orgA/../orgB/x.pdf", org_id: "orgA", record_id: DOC };
    expect((await get(DOC)).status).toBe(404);
    expect(state.fetchedKeys).toEqual([]);
  });
});
