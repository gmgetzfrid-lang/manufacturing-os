// drafting-flow Round G, DF-P15 DELIVERABLE PAGE WIRING — EVID-16 done-when 2:
// the ticket page's inline PDF preview is the STAMPED server stream.
// POST /api/tickets/copy gains channel "view": the same doors, plan and server
// stamp as a download, served inline, recorded as a VIEW row on the ticket's
// audit trail naming the file — not as a distribution copy (a viewer is not a
// copy holder) — and not served when that record cannot be written.
// REGRESSION: print and download answer exactly as DF-P12 built them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";

const st = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertErrors: {} as Record<string, Array<{ code?: string; message?: string } | null>>,
  objects: {} as Record<string, Uint8Array>,
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
      return { Body: { transformToByteArray: async () => b } };
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
