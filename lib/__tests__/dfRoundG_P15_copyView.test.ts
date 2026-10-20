// drafting-flow Round G, DF-P15 DELIVERABLE PAGE WIRING — EVID-16 done-when 2:
// the ticket page's inline PDF preview is the STAMPED server stream.
// POST /api/tickets/copy gains channel "view": the same doors, plan and server
// stamp as a download, served inline, recorded as a VIEW row on the ticket's
// audit trail naming the file — not as a distribution copy (a viewer is not a
// copy holder) — and not served when that record cannot be written.
// REGRESSION: print and download answer exactly as DF-P12 built them.
//
// DF-P15 fix (size): the response is a STREAMED body in 1 MiB chunks — never
// one buffered body, which the platform caps at ~4.5 MB — and a file over the
// stamping bound is opened (first bytes read) before anything is recorded,
// then issued unstamped through the 422 question, its reason recorded.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const st = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertErrors: {} as Record<string, Array<{ code?: string; message?: string } | null>>,
  objects: {} as Record<string, Uint8Array>,
  /** Per key: the ContentLength storage reports (a large object is not held
   *  in the test either — its stream yields these bytes), and a stream that
   *  fails on its first read. */
  meta: {} as Record<string, { contentLength?: number; streamFails?: boolean }>,
  byteArrayReads: 0,
  user: { id: "u-drafter", email: "drafter@plant.test" } as { id: string; email: string } | null,
}));

function chain(table: string) {
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void) => resolve(head ? { data: null, error: null, count: 0 } : { data: null, error: null });
      return (...args: unknown[]) => {
        if (p === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (p === "insert") {
          st.inserts.push({ table, row: args[0] as Record<string, unknown> });
          const q = st.insertErrors[table];
          return Promise.resolve({ error: q && q.length ? q.shift() ?? null : null });
        }
        if (p === "maybeSingle") {
          if (table === "tickets") return Promise.resolve({ data: st.ticket, error: null });
          if (table === "org_members") return Promise.resolve({ data: st.member, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (st.user ? { data: { user: st.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { input: { Key: string } }) => {
      const b = st.objects[cmd.input.Key];
      if (!b) throw { name: "NoSuchKey" };
      const m = st.meta[cmd.input.Key] ?? {};
      return {
        ContentLength: m.contentLength,
        Body: {
          transformToByteArray: async () => { st.byteArrayReads += 1; return b; },
          transformToWebStream: () => new ReadableStream<Uint8Array>({
            start(c) {
              if (m.streamFails) { c.error(new Error("connection reset")); return; }
              // two pieces, so the replayed first chunk and the rest both pass through
              const cut = Math.max(1, Math.floor(b.length / 2));
              c.enqueue(b.subarray(0, cut));
              if (cut < b.length) c.enqueue(b.subarray(cut));
              c.close();
            },
          }),
        },
      };
    },
  },
}));

const T = "77777777-7777-7777-7777-777777777777";
const ORG = "11111111-1111-1111-1111-111111111111";
const KEY = `orgs/${ORG}/tickets/KE-9/ifc-rev1.pdf`;
const issued = (n: number) => ({ action: `Approve (Issue for Construction) — issued Rev ${n}`, user: "eng@plant.test" });
async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return new Uint8Array(await d.save());
}
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: T, org_id: ORG, ticket_id: "KE-9", status: "PENDING_IFC", deliverable_rev: "1", revision_count: 0, history: [issued(1)],
  attachments: [{ id: "f-1", name: "ifc-rev1.pdf", url: KEY, type: "Final", status: "submitted", rev: "1" }],
  archived_at: null, requester_id: "u-req", assigned_drafter_id: "u-drafter", assigned_engineer_id: null, watchers: [], ...over,
});
async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/tickets/copy/route");
  return POST(new NextRequest("https://app.example.com/api/tickets/copy", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer good" }, body: JSON.stringify(body),
  }));
}
const ins = (t: string) => st.inserts.filter((i) => i.table === t).map((i) => i.row);

beforeEach(async () => {
  st.user = { id: "u-drafter", email: "drafter@plant.test" };
  st.member = { uid: "u-drafter", role: "Drafter", roles: ["Drafter"], email: "drafter@plant.test" };
  st.ticket = ticketRow();
  st.inserts = []; st.insertErrors = {};
  st.objects = { [KEY]: await pdfBytes() };
  st.meta = {}; st.byteArrayReads = 0;
  process.env.NEXT_PUBLIC_SITE_URL = "https://plant.example.com";
});

describe("EVID-16 done-when 2 — channel \"view\": the preview is the stamped server stream", () => {
  it("serves the STAMPED bytes inline and records one VIEW row on the ticket naming the file — no distribution row", async () => {
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true, acceptUnstamped: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="ifc-rev1_Rev1\.pdf"$/);
    expect(res.headers.get("x-ticket-copy-stamped")).toBe("1");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(st.objects[KEY].length);
    expect(ins("download_audits")).toEqual([]);
    expect(ins("audit_logs")).toEqual([expect.objectContaining({ action: "VIEW", resource_type: "ticket", resource_id: T, org_id: ORG, user_id: "u-drafter",
      details: expect.objectContaining({ channel: "view", attachmentId: "f-1", rev: "1", watermark: "UNCONTROLLED COPY" }) })]);
  });
  it("a VIEW that cannot be recorded is not served (503 unrecorded) — as a copy is not", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    st.insertErrors = { audit_logs: [{ message: "audit refused" }] };
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true, acceptUnstamped: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unrecorded", message: expect.stringMatching(/^This preview was not served/) });
  });
  it("the same doors as a copy: a superseded file asks unless acknowledged; an unstampable one asks unless accepted (then recorded as unstamped)", async () => {
    st.ticket = ticketRow({ deliverable_rev: "2", revision_count: 1, history: [issued(1), issued(2)] });
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "view" })).status).toBe(409);
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true })).status).toBe(200);
    st.inserts = [];
    st.ticket = ticketRow();
    st.objects[KEY] = new TextEncoder().encode("not a pdf");
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true })).status).toBe(422);
    const ok = await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true, acceptUnstamped: true });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-ticket-copy-stamped")).toBe("0");
    expect(ins("audit_logs")[0]).toMatchObject({ action: "VIEW", details: expect.objectContaining({ watermark: "UNSTAMPED (stamping failed)" }) });
  });
  it("a legacy absolute URL is refused for a view too (the page keeps the browser path for it)", async () => {
    st.ticket = ticketRow({ attachments: [{ id: "f-1", name: "x.pdf", url: "https://old.example.com/x.pdf", type: "Final", rev: "1" }] });
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("legacy_file");
  });
  it("REGRESSION: download is still an attachment with the distribution row and the DOWNLOAD audit row; an unknown channel is still a 400", async () => {
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "download" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(ins("download_audits")).toEqual([expect.objectContaining({ source: "drafting", ticket_id: T, attachment_id: "f-1" })]);
    expect(ins("audit_logs")).toEqual([expect.objectContaining({ action: "DOWNLOAD" })]);
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "fax" })).status).toBe(400);
  });
});

// ─── DF-P15 fix: size — streamed, never one buffered body ───────────────────
async function readChunks(res: Response): Promise<{ chunks: number; bytes: Uint8Array }> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return { chunks: parts.length, bytes };
}
const MiB = 1024 * 1024;

describe("DF-P15 fix — a file over the platform's ~4.5 MB buffered-response cap is still issued", () => {
  it("source pins: maxDuration 300, a streamed body (chunkedStream / the piped stream), never new NextResponse(Buffer.from(out))", () => {
    const s = readFileSync(join(process.cwd(), "app/api/tickets/copy/route.ts"), "utf8");
    expect(s).toContain("export const maxDuration = 300;");
    expect(s).toContain("const STREAM_CHUNK_BYTES = 1024 * 1024;");
    expect(s).toContain("return new NextResponse(piped ?? chunkedStream(out ?? new Uint8Array()), {");
    expect(s).not.toContain("Buffer.from(out)");
    // the record still precedes the response that carries the bytes
    expect(s.indexOf("recordTicketCopy(supabaseAdmin, audit,")).toBeLessThan(s.indexOf("return new NextResponse(piped ??"));
    // the large file's stream is opened before the record is written
    expect(s.indexOf("await openPeeked(stream)")).toBeLessThan(s.indexOf("recordTicketCopy(supabaseAdmin, audit,"));
  });
  it("a stamped PDF over 4.5 MB is issued STAMPED as a streamed body in 1 MiB chunks, recorded once", async () => {
    const d = await PDFDocument.create();
    d.addPage([612, 792]);
    const pad = new Uint8Array(randomBytes(5 * MiB)); // incompressible
    await d.attach(pad, "pad.bin", { mimeType: "application/octet-stream" });
    const big = new Uint8Array(await d.save({ useObjectStreams: false }));
    expect(big.length).toBeGreaterThan(4.5 * MiB);
    st.objects[KEY] = big;
    st.meta[KEY] = { contentLength: big.length };
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "print" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ticket-copy-stamped")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const { chunks, bytes } = await readChunks(res);
    expect(bytes.length).toBeGreaterThan(4.5 * MiB);
    expect(chunks).toBeGreaterThanOrEqual(Math.ceil(bytes.length / MiB));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(ins("download_audits")).toEqual([expect.objectContaining({ source: "drafting_print", ticket_id: T, attachment_id: "f-1" })]);
  }, 30_000);
  it("a file over the stamping bound (64 MB) is never held whole: asked as unstampable (reason: its size), then piped through UNSTAMPED, its reason recorded", async () => {
    const bytes = await pdfBytes();
    st.objects[KEY] = bytes;
    st.meta[KEY] = { contentLength: 70 * MiB };
    const asked = await post({ ticketId: T, attachmentId: "f-1", channel: "download" });
    expect(asked.status).toBe(422);
    expect((await asked.json()).message).toMatch(/the file is 70 MB, over the 64 MB the server stamps/);
    expect(st.inserts).toEqual([]);
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "download", acceptUnstamped: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ticket-copy-stamped")).toBe("0");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="ifc-rev1\.pdf"$/);
    const out = await readChunks(res);
    expect(Array.from(out.bytes)).toEqual(Array.from(bytes)); // the replayed first chunk + the rest, byte for byte
    expect(st.byteArrayReads).toBe(0); // never read whole
    expect(ins("download_audits")).toEqual([expect.objectContaining({ source: "drafting_unstamped" })]);
    expect(ins("audit_logs")).toEqual([expect.objectContaining({ action: "DOWNLOAD",
      details: expect.objectContaining({ watermark: "UNSTAMPED (stamping failed)", unstampedReason: "the file is 70 MB, over the 64 MB the server stamps" }) })]);
  });
  it("a large file whose stream cannot be opened records NOTHING (502) — a failed send never leaves a distribution row naming a copy that never arrived", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    st.meta[KEY] = { contentLength: 70 * MiB, streamFails: true };
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "print", acknowledged: true, acceptUnstamped: true });
    expect(res.status).toBe(502);
    expect(st.inserts).toEqual([]);
  });
  it("a large file whose record is refused is not issued (503) and its stream is released", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    st.meta[KEY] = { contentLength: 70 * MiB };
    st.insertErrors = { audit_logs: [{ message: "audit refused" }] };
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "download", acceptUnstamped: true });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("unrecorded");
  });
  it("an unstamped in-memory copy (not a PDF) is streamed in chunks and its reason recorded; a non-PDF is octet-stream, never a stored content type", async () => {
    const blob = new Uint8Array(3 * MiB + 17).fill(0x41);
    st.objects[KEY] = blob;
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "download", acceptUnstamped: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const out = await readChunks(res);
    expect(out.bytes.length).toBe(blob.length);
    expect(out.chunks).toBe(4);
    expect(ins("audit_logs")[0]).toMatchObject({ details: expect.objectContaining({ unstampedReason: "the file is not a PDF" }) });
  });
});
