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
//   fix pass       the response is a STREAMED body (never one buffered body —
//                  the platform caps a buffered response at ~4.5 MB); a file
//                  over the stamping bound is hashed chunk by chunk, re-read
//                  pinned to the verified ETag (If-Match) and piped through
//                  unstamped, recorded with the reason.
//   TRX-15 (P8)    a PDF that cannot be stamped (over the bound, or one the
//                  stamper refuses) goes out recorded unstamped (DEC-61 §5)
//                  and the ISSUER IS TOLD, once per transmittal and document
//                  (deduped on a delivered bell notice); only an item the
//                  issue-time check (TRX-16) marked `stampable: true` is held
//                  to "stamped or not at all" — 422 "unstampable", nothing
//                  recorded as delivered, the refusal on the issuer's trail.
//                  `&nav=1` answers a refusal as plain text for the portal
//                  page's download frame.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  // the object store: a claimed ContentLength (null = the real length), its
  // ETag, every GET's input, a failure for the pinned second read, and
  // whether a piped body was released
  contentLength: null as number | null,
  etag: '"etag-1"' as string | null,
  getInputs: [] as Array<Record<string, unknown>>,
  secondGetError: null as Error | null,
  destroyed: 0,
  // TRX-15 (fix pass): what the issuer is told
  notifications: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
  issuerEmail: null as string | null,
  // a refused bell / email insert (supabase-js resolves { error }, never rejects)
  notificationInsertError: null as { message: string } | null,
  emailInsertError: null as { message: string } | null,
  // TRX-15 fix pass 3: every `.in()` size on document_versions, and the
  // windows of the snapshot's record / trail reads
  versionInSizes: [] as number[],
  ranges: [] as Array<{ table: string; from: number; to: number }>,
  downloadReadError: null as { message: string; code?: string } | null,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  let op: "select" | "update" | "insert" = "select";
  let payload: Record<string, unknown> | null = null;
  const c: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  const windowed = <T,>(rows: T[]): T[] => {
    if (!range) return rows;
    state.ranges.push({ table, from: range[0], to: range[1] });
    return rows.slice(range[0], range[1] + 1);
  };
  const resolveList = () => {
    if (table === "download_audits" && op === "select") {
      // the snapshot's read of the copies that left unmarked
      if (state.downloadReadError) return { data: null, error: state.downloadReadError };
      const rows = state.downloads.filter((d) => d.transmittal_id === filters.transmittal_id && d.source === filters.source);
      return { data: windowed(rows.map((d) => ({ document_id: d.document_id }))), error: null };
    }
    if (table === "document_versions") {
      state.fallbackFilters.push({ ...filters });
      const rows = state.versionRows.filter((r) => filters.org_id === (r.org_id ?? null));
      return { data: rows, error: null };
    }
    if (table === "transmittals" && op === "update") {
      state.updates.push({ ...payload!, __filters: { ...filters } });
      return { data: state.updateRows, error: null };
    }
    if (table === "notifications" && op === "select") {
      // the dedupe read: a bell notice of this kind, transmittal and document that was WRITTEN
      const rows = state.notifications.filter((n) =>
        n.kind === filters.kind && n.resource_type === filters.resource_type && n.resource_id === filters.resource_id &&
        (n.metadata as Record<string, unknown> | undefined)?.documentId === filters["metadata->>documentId"]);
      return { data: rows.map((_, i) => ({ id: `n${i}` })), error: null };
    }
    if (table === "audit_logs" && op === "select") {
      // the trail rows of this action and transmittal — by document (a dedupe
      // read), or the unstamped ones (the snapshot's read of why)
      const rows = state.audits.filter((a) => {
        const d = (a.details as Record<string, unknown> | undefined) ?? {};
        return a.action === filters.action && a.resource_id === filters.resource_id &&
          (filters["details->>documentId"] === undefined || d.documentId === filters["details->>documentId"]) &&
          (filters["details->>stamped"] === undefined || String(d.stamped) === filters["details->>stamped"]);
      });
      return { data: windowed(rows.map((a, i) => ({ id: `a${i}`, details: a.details }))), error: null };
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
        if (prop === "range") range = [Number(args[0]), Number(args[1])];
        if (prop === "in" && table === "document_versions") state.versionInSizes.push((args[1] as unknown[]).length);
        if (prop === "insert") {
          op = "insert";
          const row = args[0] as Record<string, unknown>;
          if (table === "audit_logs") { state.audits.push(row); return Promise.resolve({ error: null }); }
          if (table === "notifications") {
            if (state.notificationInsertError) return Promise.resolve({ error: state.notificationInsertError });
            state.notifications.push(row); return Promise.resolve({ error: null });
          }
          if (table === "email_notifications") {
            if (state.emailInsertError) return Promise.resolve({ error: state.emailInsertError });
            state.emails.push(row); return Promise.resolve({ error: null });
          }
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
          if (table === "org_members") return Promise.resolve({ data: state.issuerEmail ? { email: state.issuerEmail } : null, error: null });
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
    send: vi.fn(async (cmd: { input: { Key: string; IfMatch?: string } }) => {
      state.fetchedKeys.push(cmd.input.Key);
      state.getInputs.push({ ...cmd.input });
      if (cmd.input.IfMatch !== undefined && state.secondGetError) throw state.secondGetError;
      const bytes = state.bytes;
      return {
        Body: {
          transformToByteArray: async () => bytes,
          // a Node SDK body is async-iterable — small chunks, so the PDF sniff spans chunks
          async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3); },
          transformToWebStream: () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
          destroy: () => { state.destroyed += 1; },
        },
        ContentType: state.contentType,
        ContentLength: state.contentLength ?? bytes.length,
        ETag: state.etag ?? undefined,
      };
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
import { applyStampToPdfDoc } from "@/lib/stamping";

const TOKEN = "abcdefabcdefabcdefabcdefabcdefab";
const DOC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function get(file?: string, extra?: Record<string, string>): Promise<Response> {
  const u = new URL("https://app/api/transmittal");
  u.searchParams.set("token", TOKEN);
  if (file) u.searchParams.set("file", file);
  for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
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
  state.contentLength = null;
  state.etag = '"etag-1"';
  state.getInputs = [];
  state.secondGetError = null;
  state.destroyed = 0;
  state.notifications = [];
  state.emails = [];
  state.issuerEmail = null;
  state.notificationInsertError = null;
  state.emailInsertError = null;
  state.versionInSizes = [];
  state.ranges = [];
  state.downloadReadError = null;
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
    expect(res.headers.get("x-transmittal-stamped")).toBe("1");
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
    expect(res.headers.get("x-transmittal-stamped")).toBe("0");
    const a = state.audits.find((x) => x.action === "TRANSMITTAL_PORTAL_DOWNLOAD")!;
    expect((a.details as Record<string, unknown>).unstampedReason).toBe("not_pdf");
  });

  it("the route source signs nothing and returns no URL", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/transmittal/route.ts", "utf8");
    expect(src).not.toMatch(/getSignedUrl/);
    expect(src).not.toMatch(/NextResponse\.json\(\{ url/);
  });
});

describe("size — a streamed body, never one buffered response; a large file is verified, pinned and piped", () => {
  beforeEach(() => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.dwg`, org_id: "orgA", record_id: DOC, revision_label: "3" };
    // A large NON-PDF (a drawing model) is the file the pinned pipe carries
    // since TRX-15 — a large PDF is refused (below).
    state.bytes = new TextEncoder().encode("AC1027 a large CAD model, not a pdf");
    state.contentType = "application/acad";
  });

  it("a 5 MB file (over the ~4.5 MB buffered-response cap) comes back whole, as a stream read in several chunks", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    state.bytes = big;
    state.contentType = "application/acad";
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = sha(big);
    const res = await get(DOC);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const parts: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
    expect(parts.length).toBeGreaterThanOrEqual(5); // 1 MiB chunks — not one buffered body
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBe(big.length);
    const joined = new Uint8Array(total);
    let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; }
    expect(sha(joined)).toBe(sha(big));
    expect(state.downloads).toHaveLength(1);
    expect(state.getInputs).toHaveLength(1); // held once, read once
  });

  it("a NON-PDF over the stamping bound is hashed chunk by chunk, re-read pinned to the verified ETag, piped through unstamped and recorded with the reason", async () => {
    state.contentLength = 64 * 1024 * 1024 + 1; // claimed by the store; the bytes stay small in the test
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = sha(state.bytes);
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.stamps).toHaveLength(0);
    expect(state.getInputs).toEqual([
      { Bucket: "b", Key: `orgs/orgA/d/${DOC}.dwg` },
      { Bucket: "b", Key: `orgs/orgA/d/${DOC}.dwg`, IfMatch: '"etag-1"' },
    ]);
    expect(res.headers.get("x-transmittal-stamped")).toBe("0");
    expect(res.headers.get("content-type")).toBe("application/acad"); // the object's own type
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(state.bytes));
    expect(state.downloads[0].source).toBe("transmittal_portal_unstamped");
    const a = state.audits.find((x) => x.action === "TRANSMITTAL_PORTAL_DOWNLOAD")!;
    expect(a.details).toMatchObject({ stamped: false, unstampedReason: "not_pdf", servedSha256: sha(state.bytes), hashVerified: true });
  });

  it("a large file whose digest does not match releases nothing and is never re-read", async () => {
    state.contentLength = 64 * 1024 * 1024 + 1;
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = "deadbeef";
    const res = await get(DOC);
    expect(res.status).toBe(409);
    expect(state.getInputs).toHaveLength(1);
    expect(state.downloads).toHaveLength(0);
  });

  it("a large object replaced between the check and the send (If-Match refused) records nothing (502)", async () => {
    state.contentLength = 64 * 1024 * 1024 + 1;
    state.secondGetError = Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed" });
    const res = await get(DOC);
    expect(res.status).toBe(502);
    expect(state.downloads).toHaveLength(0);
  });

  it("a large object with no ETag cannot be pinned, so it is not sent (502)", async () => {
    state.contentLength = 64 * 1024 * 1024 + 1;
    state.etag = null;
    expect((await get(DOC)).status).toBe(502);
    expect(state.downloads).toHaveLength(0);
  });

  it("a refused record releases the opened second read (503, the body destroyed)", async () => {
    state.contentLength = 64 * 1024 * 1024 + 1;
    state.downloadErrors = [{ code: "42501", message: "permission denied" }];
    const res = await get(DOC);
    expect(res.status).toBe(503);
    expect(state.destroyed).toBe(1);
  });

  it("the route streams (no buffered Buffer body) and has the budget to drain a large download", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/transmittal/route.ts", "utf8");
    expect(src).not.toMatch(/new NextResponse\(Buffer\.from\(/);
    expect(src).toContain("return new NextResponse(piped ? piped.stream : chunkedStream(outBytes ?? new Uint8Array()), {");
    expect(src).toContain("export const maxDuration = 300;");
    expect(src).toContain("const PORTAL_STAMP_MAX_BYTES = 64 * 1024 * 1024;");
    expect(src).toContain("new GetObjectCommand({ Bucket: R2_BUCKET, Key: file.key, IfMatch: etag ?? undefined })");
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
      documentId: DOC, number: "P-101", title: null, rev: "3", statusAsSent: "Issued", effectiveDate: "2026-11-01", fileHash: "abc123", fileSize: null,
      notYetInForce: expect.any(Boolean), // REV-9 — decided in the facility's calendar (pinned below)
      releasedUnmarked: null,             // TRX-15 — no version row in this fixture: unknown
      unmarkedReason: null,
    });
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileSize = 2516582;
    const again = await (await get()).json() as Record<string, unknown>;
    expect((again.items as Array<Record<string, unknown>>)[0].fileSize).toBe(2516582);
    expect(state.rpcs).toEqual([
      { fn: "bump_transmittal_portal_use", args: { p_id: "t1", p_kind: "open" } },
      { fn: "bump_transmittal_portal_use", args: { p_id: "t1", p_kind: "open" } },
    ]);
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

// ─── document-control Round F wave 2, P8 FIELD ─────────────────────────────

function getNav(file: string): Promise<Response> {
  const u = new URL("https://app/api/transmittal");
  u.searchParams.set("token", TOKEN);
  u.searchParams.set("file", file);
  u.searchParams.set("nav", "1");
  return GET(new NextRequest(u));
}

describe("TRX-15 — a PDF that cannot be stamped: released recorded-unstamped with the issuer told (DEC-61 §5), refused only when the issue-time check marked it stampable (TRX-16)", () => {
  const arm = () => { (state.transmittal!.items as Array<Record<string, unknown>>)[0].stampable = true; };
  const restoreStamp = () => {
    vi.mocked(applyStampToPdfDoc).mockReset();
    vi.mocked(applyStampToPdfDoc).mockImplementation(async (_doc: unknown, opts: Record<string, unknown>) => { state.order.push("stamp"); state.stamps.push(opts); });
  };
  beforeEach(() => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
  });

  it("an item issued WITHOUT the issue-time mark (every live transmittal today): a PDF over the bound is verified, re-read pinned and piped UNSTAMPED, recorded so — and the issuer is told", async () => {
    state.issuerEmail = "issuer@acme.com";
    state.contentLength = 64 * 1024 * 1024 + 1; // claimed by the store; the bytes stay small in the test
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = sha(state.bytes);
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.destroyed).toBe(0);                    // read whole, chunk by chunk — not stopped at the header
    expect(state.getInputs).toEqual([
      { Bucket: "b", Key: `orgs/orgA/d/${DOC}.pdf` },
      { Bucket: "b", Key: `orgs/orgA/d/${DOC}.pdf`, IfMatch: '"etag-1"' },
    ]);
    expect(state.stamps).toHaveLength(0);
    expect(res.headers.get("x-transmittal-stamped")).toBe("0");
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(state.bytes));
    expect(state.downloads[0].source).toBe("transmittal_portal_unstamped");
    const a = state.audits.find((x) => x.action === "TRANSMITTAL_PORTAL_DOWNLOAD")!;
    expect(a.details).toMatchObject({ stamped: false, unstampedReason: "oversize", hashVerified: true });
    expect(state.audits.some((x) => x.action === "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED")).toBe(false);
    // the issuer is told it left WITHOUT the marking (never a silent unmarked copy)
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      kind: "transmittal_unstampable", user_id: "issuer1", resource_type: "transmittal", resource_id: "t1",
      metadata: { documentId: DOC, reason: "oversize", outcome: "released" },
    });
    expect(String(state.notifications[0].title)).toBe("Transmittal TR-0001: P-101 Rev 3 went to the recipient WITHOUT the UNCONTROLLED marking");
    expect(String(state.notifications[0].body)).toMatch(/larger than the portal can mark \(64 MB\).*recorded as unstamped/);
    expect(state.emails).toEqual([expect.objectContaining({ to_email: "issuer@acme.com", event_type: "transmittal_unstamped", status: "queued" })]);
  });

  it("an unmarked item: a PDF the stamper refuses (encrypted / permission-restricted) goes out as issued, recorded unstamped (stamp_failed), the issuer told once", async () => {
    vi.mocked(applyStampToPdfDoc).mockImplementation(async () => {
      throw new Error("Input document to `PDFDocument.load` is encrypted.");
    });
    try {
      const res = await get(DOC);
      expect(res.status).toBe(200);
      expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(state.bytes)); // the as-issued bytes
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(state.downloads[0].source).toBe("transmittal_portal_unstamped");
      const a = state.audits.find((x) => x.action === "TRANSMITTAL_PORTAL_DOWNLOAD")!;
      expect(a.details).toMatchObject({ stamped: false, unstampedReason: "stamp_failed" });
      expect(state.notifications).toHaveLength(1);
      expect(String(state.notifications[0].body)).toMatch(/security or permission restrictions \(common for vendor and certified drawings\)/);
      // a second pull: delivered again, recorded again, the issuer NOT told twice
      expect((await get(DOC)).status).toBe(200);
      expect(state.downloads).toHaveLength(2);
      expect(state.notifications).toHaveLength(1);
    } finally {
      restoreStamp();
    }
  });

  it("an item the issue-time check marked stampable: a PDF over the bound is REFUSED (422 unstampable / oversize) — the rest never read, nothing recorded as delivered, the refusal on the issuer's trail", async () => {
    arm();
    state.contentLength = 64 * 1024 * 1024 + 1;
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileHash = sha(state.bytes);
    const res = await get(DOC);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unstampable", reason: "oversize" });
    expect(state.getInputs).toHaveLength(1);           // never re-read for a send
    expect(state.destroyed).toBe(1);                    // the first read released at the PDF header
    expect(state.stamps).toHaveLength(0);
    expect(state.downloads).toHaveLength(0);            // no copy recorded — none left
    expect(state.rpcs.filter((r) => r.args.p_kind === "download")).toHaveLength(0);
    const trail = state.audits.find((a) => a.action === "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED")!;
    expect(trail).toBeTruthy();
    expect(trail.user_id).toBe("issuer1");
    expect(trail.details).toMatchObject({ number: "TR-0001", documentId: DOC, versionId: VER, reason: "oversize", maxStampBytes: 64 * 1024 * 1024 });
    expect(state.audits.some((a) => a.action === "TRANSMITTAL_PORTAL_DOWNLOAD")).toBe(false);
    expect(state.notifications[0]).toMatchObject({ metadata: { documentId: DOC, reason: "oversize", outcome: "refused" } });
    expect(String(state.notifications[0].body)).toMatch(/larger than the portal can mark \(64 MB\)/);
  });

  it("a marked item the stamper refuses is REFUSED (422 unstampable / stamp_failed) — never delivered unstamped; the issuer told once (deduped on the delivered bell notice)", async () => {
    arm();
    state.issuerEmail = "issuer@acme.com";
    vi.mocked(applyStampToPdfDoc).mockImplementation(async () => {
      throw new Error("Input document to `PDFDocument.load` is encrypted.");
    });
    try {
      const res = await get(DOC);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "unstampable", reason: "stamp_failed" });
      expect(state.downloads).toHaveLength(0);
      const trail = state.audits.find((a) => a.action === "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED")!;
      expect(trail.details).toMatchObject({ reason: "stamp_failed", detail: expect.stringMatching(/encrypted/) });
      expect(state.notifications).toHaveLength(1);
      const n = state.notifications[0];
      expect(n).toMatchObject({
        org_id: "orgA", user_id: "issuer1", kind: "transmittal_unstampable",
        link: "/transmittals", resource_type: "transmittal", resource_id: "t1",
        metadata: { documentId: DOC, reason: "stamp_failed", outcome: "refused" },
      });
      expect(String(n.title)).toBe("Transmittal TR-0001: P-101 Rev 3 was refused to the recipient");
      expect(String(n.body)).toMatch(/this one still reads issued on the register/);
      expect(state.emails).toHaveLength(1);
      expect(state.emails[0]).toMatchObject({ to_user_id: "issuer1", to_email: "issuer@acme.com", subject: n.title, event_type: "transmittal_refused", status: "queued" });
      // the recipient retries: refused again, on the trail again, but the issuer is not told twice
      expect((await get(DOC)).status).toBe(422);
      expect(state.audits.filter((a) => a.action === "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED")).toHaveLength(2);
      expect(state.notifications).toHaveLength(1);
      expect(state.emails).toHaveLength(1);
    } finally {
      restoreStamp();
    }
  });

  it("a bell notice whose insert FAILED is not 'told': the failure is logged and the next pull tells the issuer again (never silenced by the trail)", async () => {
    vi.mocked(applyStampToPdfDoc).mockImplementation(async () => { throw new Error("encrypted"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state.issuerEmail = "issuer@acme.com";
      state.notificationInsertError = { message: "new row violates row-level security policy" };
      state.emailInsertError = { message: "relation is read-only" };
      expect((await get(DOC)).status).toBe(200);
      expect(state.notifications).toHaveLength(0);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/bell notice of an unstamped PDF was refused/), "new row violates row-level security policy");
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/email notice of an unstamped PDF could not be queued/), "relation is read-only");
      state.notificationInsertError = null;
      state.emailInsertError = null;
      expect((await get(DOC)).status).toBe(200);
      expect(state.notifications).toHaveLength(1);
      expect(state.emails).toHaveLength(1);
    } finally {
      err.mockRestore();
      restoreStamp();
    }
  });

  it("the email queue is kicked on the configured public origin (publicOrigin), never on the address the request names; no issuer → nobody to tell", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "s3cret";
    const kicks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { kicks.push(String(url)); return new Response(null, { status: 202 }); }));
    try {
      state.issuerEmail = "issuer@acme.com";
      state.contentLength = 64 * 1024 * 1024 + 1;
      // the request arrives on another host (a rewritten URL / a trusted Host header)
      const u = new URL("https://attacker.example/api/transmittal");
      u.searchParams.set("token", TOKEN);
      u.searchParams.set("file", DOC);
      expect((await GET(new NextRequest(u))).status).toBe(200);
      expect(kicks).toEqual(["https://app.example.com/api/notifications/send-queued"]);
      const route = readFileSync("app/api/transmittal/route.ts", "utf8");
      const tell = route.slice(route.indexOf("async function tellIssuerUnstampable("), route.indexOf("export async function GET("));
      expect(tell).not.toMatch(/req\.nextUrl\.origin|origin: string/);
      expect(tell).toContain("const origin = publicOrigin();");
      state.notifications = []; state.emails = [];
      state.transmittal!.created_by = null;
      expect((await get(DOC)).status).toBe(200);
      expect(state.notifications).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    }
  });

  it("the refusal is ARMED only by the issue-time mark (`stampable: true`), so a live transmittal issued before TRX-16 is never refused at download for a file nobody checked", () => {
    const src = readFileSync("app/api/transmittal/route.ts", "utf8");
    expect(src).toContain("function refusesUnstampable(item: Item): boolean {\n  return item.stampable === true;\n}");
    expect(src).toContain("const armed = refusesUnstampable(item);");
    expect(src).toContain("await hashBody(obj.Body, { stopIfPdf: armed })");
    expect(src).toContain('if (isPdf && !source && armed) return refuseUnstampable("oversize", null);');
    expect(src).toContain('if (armed) return refuseUnstampable("stamp_failed", (e as Error).message || null);');
    // DEC-61 §5's fallback is back for everything else, recorded with the reason
    expect(src).toContain('let unstampedReason: "not_pdf" | "oversize" | "stamp_failed" | null = !isPdf ? "not_pdf" : source ? null : "oversize";');
    expect(src).toContain('await tellIssuerUnstampable(t, item, unstampedReason, "released");');
  });

  it("&nav=1 (the portal page's download frame): a refusal is plain text carrying the status; without it the JSON answer is unchanged", async () => {
    const r1 = await getNav("ffffffff-ffff-ffff-ffff-ffffffffffff"); // not on the transmittal
    expect(r1.status).toBe(403);
    expect(r1.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await r1.text())).toEqual({ error: "That document is not on this transmittal.", status: 403 });
    state.transmittal!.portal_revoked_at = "2026-09-10T00:00:00Z";
    const r2 = await getNav(DOC);
    expect(r2.status).toBe(410);
    expect(JSON.parse(await r2.text())).toEqual({ error: "revoked", status: 410 });
    state.transmittal!.portal_revoked_at = null;
    arm();
    state.contentLength = 64 * 1024 * 1024 + 1;
    const r3 = await getNav(DOC);
    expect(JSON.parse(await r3.text())).toEqual({ error: "unstampable", reason: "oversize", status: 422 });
    // a successful navigation is the attachment itself
    state.contentLength = null;
    const ok = await getNav(DOC);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe('attachment; filename="P-101_Rev3.pdf"');
    // and the JSON callers are untouched
    const j = await get("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(j.headers.get("content-type")).toMatch(/application\/json/);
    expect(await j.json()).toEqual({ error: "That document is not on this transmittal." });
  });

  it("the portal page never holds a download in memory (a hidden frame, &nav=1), and always offers a VISIBLE link to the same address — a browser that drops a hidden-frame attachment (iOS Safari, Firefox: not yet checked) still gets the file", () => {
    const page = readFileSync("app/transmittal/[token]/page.tsx", "utf8");
    expect(page).not.toMatch(/res\.blob\(\)|\.blob\(\)/);
    expect(page).not.toMatch(/createObjectURL/);
    expect(page).toContain('document.createElement("iframe")');
    expect(page).toContain("return `/api/transmittal?token=${encodeURIComponent(token)}&file=${encodeURIComponent(docId)}&nav=1`;");
    expect(page).toContain("frame.src = fileHref(token, docId);");
    expect(page).toMatch(/frameRefusal\(text\)/);
    // the fallback: the SAME address, as a top-level navigation, once a download was started
    expect(page).toMatch(/\{started\.has\(i\.documentId\) && \([\s\S]{0,400}?href=\{fileHref\(token, i\.documentId\)\}\s*\n\s*target="_blank"/);
    expect(page).toContain("Download didn&apos;t start? Open the file directly");
    // and the page never claims the browser saved it
    expect(page).not.toMatch(/your browser is saving the file/);
    // the refusal it can receive is explained
    expect(page).toMatch(/code === "unstampable"/);
    // a large PDF released unmarked is said to be (DEC-61 §5)
    expect(page).toContain('i.unmarkedReason === "oversize"');
    expect(page).toMatch(/a PDF too large to mark, or a PDF saved with security restrictions — is released as issued, without the marking/);
  });
});

describe("REV-9 — the portal's 'not yet in force' is decided in the facility's calendar, not the recipient's browser or UTC", () => {
  const prevZone = process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
  afterEach(() => {
    vi.useRealTimers();
    if (prevZone === undefined) delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
    else process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = prevZone;
  });

  it("Houston evening before the effective date → not yet in force; the facility's next morning → in force", async () => {
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    (state.transmittal!.items as Array<Record<string, unknown>>)[0] = {
      documentId: DOC, number: "P-101", rev: "3", versionId: VER, effectiveDate: "2026-08-22",
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T01:30:00Z")); // 20:30 on 21 Aug in Houston — already 22 Aug in UTC
    let body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0].notYetInForce).toBe(true);
    vi.setSystemTime(new Date("2026-08-22T06:00:00Z")); // 01:00 on 22 Aug in Houston
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0].notYetInForce).toBe(false);
  });

  it("the page reads the route's flag — no inline UTC 'today'", () => {
    const page = readFileSync("app/transmittal/[token]/page.tsx", "utf8");
    expect(page).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(page).toContain("i.notYetInForce");
    const route = readFileSync("app/api/transmittal/route.ts", "utf8");
    expect(route).toContain('notYetInForce: effectiveStatusFor(i.effectiveDate ?? null) === "pending",');
  });
});

describe("TRX-15 — the snapshot flags a pinned file that leaves unmarked (the page can no longer read the download's headers)", () => {
  it("a .dwg pin → releasedUnmarked true (not_pdf); a PDF pin → false; read scoped to the transmittal's org", async () => {
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.dwg`, file_type: "application/acad", org_id: "orgA" }];
    let body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: "not_pdf" });
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.pdf`, file_type: "application/pdf", org_id: "orgA" }];
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: false, unmarkedReason: null });
    // another org's row of the same id resolves nothing → unknown
    state.versionRows = [{ id: VER, file_url: `orgs/orgB/d/x.dwg`, file_type: null, org_id: "orgB" }];
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: null, unmarkedReason: null });
  });

  it("a PDF over the stamping bound (by the size recorded at issue, else the version's) → releasedUnmarked true (oversize); an item marked stampable is refused instead, so never flagged", async () => {
    const big = 64 * 1024 * 1024 + 1;
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.pdf`, file_type: "application/pdf", size: big, org_id: "orgA" }];
    let body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: "oversize" });
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.pdf`, file_type: "application/pdf", size: 10, org_id: "orgA" }];
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].fileSize = big;
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: "oversize" });
    (state.transmittal!.items as Array<Record<string, unknown>>)[0].stampable = true;
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: false, unmarkedReason: null });
  });

  it("a PDF the STAMPER refused (stamp_failed — known only at download) is flagged once a copy has left: the record says THAT it left unmarked, the trail says WHY (fix pass 3)", async () => {
    // a small, ordinary-looking PDF pin: nothing up front says it will leave unmarked
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.pdf`, file_type: "application/pdf", size: 10, org_id: "orgA" }];
    let body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: false, unmarkedReason: null });
    // the recipient pulls it; the stamper refuses (a permission-restricted vendor PDF) → released unmarked (DEC-61 §5)
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", record_id: DOC, revision_label: "3" };
    vi.mocked(applyStampToPdfDoc).mockImplementationOnce(async () => { throw new Error("Input document to `PDFDocument.load` is encrypted."); });
    expect((await get(DOC)).status).toBe(200);
    expect(state.downloads[0].source).toBe("transmittal_portal_unstamped");
    // the page's re-read now says so — with the reason
    body = await (await get(undefined, { recheck: "1" })).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: "stamp_failed" });
    // a later STAMPED pull does not recall the unmarked copy already out
    expect((await get(DOC)).status).toBe(200);
    expect(state.downloads[1].source).toBe("transmittal_portal");
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: "stamp_failed" });
    // the reads are paged (max-rows never truncates them silently)
    expect(state.ranges.some((r) => r.table === "download_audits" && r.from === 0 && r.to === 999)).toBe(true);
    expect(state.ranges.some((r) => r.table === "audit_logs" && r.from === 0 && r.to === 999)).toBe(true);
  });

  it("the record without a trail reason still flags the copy (reason unknown); a record read that fails flags nothing — never 'marked' (fix pass 3)", async () => {
    state.versionRows = [{ id: VER, file_url: `orgs/orgA/d/${DOC}.pdf`, file_type: "application/pdf", size: 10, org_id: "orgA" }];
    state.downloads = [{ document_id: DOC, transmittal_id: "t1", source: "transmittal_portal_unstamped" }];
    let body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: true, unmarkedReason: null });
    // another transmittal's unmarked copy is not this one's
    state.downloads = [{ document_id: DOC, transmittal_id: "t2", source: "transmittal_portal_unstamped" }];
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: false });
    // a database without the 20261068 columns: the read errors → the item keeps what the file says
    state.downloadReadError = { code: "42703", message: "column download_audits.transmittal_id does not exist" };
    body = await (await get()).json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ releasedUnmarked: false, unmarkedReason: null });
  });

  it("the page's re-read after a download (`&recheck=1`) is not an open on the usage trail (fix pass 3)", async () => {
    await get(undefined, { recheck: "1" });
    expect(state.rpcs).toEqual([]);
    await get();
    expect(state.rpcs).toEqual([{ fn: "bump_transmittal_portal_use", args: { p_id: "t1", p_kind: "open" } }]);
  });

  it("the snapshot's pinned-version read is chunked at 150 ids (fix pass 3)", async () => {
    state.transmittal!.items = Array.from({ length: 320 }, (_, i) => ({
      documentId: `doc-${i}`, number: `P-${i}`, rev: "1", versionId: `ver-${i}`,
    }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.versionInSizes).toEqual([150, 150, 20]);
  });

  it("the page re-reads the snapshot after a download and says a copy left unmarked — a stamper refusal included (fix pass 3)", () => {
    const page = readFileSync("app/transmittal/[token]/page.tsx", "utf8");
    expect(page).toContain('fetch(`/api/transmittal?token=${encodeURIComponent(token)}${opts?.recheck ? "&recheck=1" : ""}`)');
    expect(page).toMatch(/void refresh\(\{ recheck: true \}\)\.then\(\(fresh\) => \{[\s\S]{0,200}?item\?\.releasedUnmarked === true/);
    expect(page).toContain("window.setTimeout(() => { void refresh({ recheck: true }); }, DOWNLOAD_RECHECK_MS);");
    expect(page).toContain('if (i.unmarkedReason === "stamp_failed") {');
    expect(page).toMatch(/the copy downloaded " \+\s*\n\s*`from this link was released as issued, WITHOUT the marking, the as-issued footer or the verify QR \(the issuer is told\)/);
    // a copy flagged with no reason on the trail still gets a line
    expect(page).toContain("A copy downloaded from this link was released as issued, WITHOUT the UNCONTROLLED marking (the issuer is told).");
  });
});
