// document-control Round F wave 3 — P15 SURFACE REMAINDERS: TRX-16, the
// server half. lib/transmittalStampCheck.ts runs the portal's own stamp test
// at ISSUE — a size bound, the first bytes, a pdf-lib load with no
// ignoreEncryption, and the portal's stamp on the loaded (then discarded)
// document — against the file the issue will pin; /api/transmittal/stamp-check
// answers it for a draft, to a transmit authority, read-only.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  docs: {} as Record<string, Row | null>,
  versions: {} as Record<string, Row | null>,
  readErrors: {} as Record<string, { message: string } | undefined>,
  objects: {} as Record<string, { ContentLength?: number; bytes: Uint8Array }>,
  fetched: [] as string[],
  destroyed: 0,
  writes: [] as Array<{ table: string; op: string }>,
  user: { id: "u-dc" } as { id: string } | null,
  transmittal: null as Row | null,
  authority: { allowed: true, member: { role: "DocCtrl", roles: ["DocCtrl"], email: "dc@a" } } as Row,
}));

function chain(table: string) {
  const eqs: Record<string, unknown> = {};
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
      return (...args: unknown[]) => {
        if (prop === "eq") eqs[String(args[0])] = args[1];
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") st.writes.push({ table, op: prop });
        if (prop === "maybeSingle" || prop === "single") {
          if (st.readErrors[table]) return Promise.resolve({ data: null, error: st.readErrors[table] });
          if (table === "transmittals") return Promise.resolve({ data: st.transmittal, error: null });
          const id = String(eqs.id);
          if (table === "documents") return Promise.resolve({ data: eqs.org_id === "org-a" ? (st.docs[id] ?? null) : null, error: null });
          if (table === "document_versions") return Promise.resolve({ data: eqs.org_id === "org-a" ? (st.versions[id] ?? null) : null, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const admin = vi.hoisted(() => ({
  client: {
    from: (t: string) => chain(t),
    auth: { getUser: async () => ({ data: { user: st.user }, error: st.user ? null : { message: "no" } }) },
  } as unknown,
}));
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: admin.client }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { constructor(public input: { Key: string }) {} } }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: vi.fn(async (cmd: { input: { Key: string } }) => {
      const o = st.objects[cmd.input.Key];
      st.fetched.push(cmd.input.Key);
      if (!o) throw new Error("NoSuchKey");
      return {
        ContentLength: o.ContentLength ?? o.bytes.byteLength,
        Body: { transformToByteArray: async () => o.bytes, destroy: () => { st.destroyed++; } },
      };
    }),
  },
}));
vi.mock("@/lib/transmittals", async (orig) => ({
  ...(await orig<typeof import("@/lib/transmittals")>()),
  evaluateTransmitAuthority: vi.fn(async () => st.authority),
}));

import { checkItemsStampable, STAMP_CHECK_TIME_BUDGET_MS } from "@/lib/transmittalStampCheck";
import { PORTAL_STAMP_MAX_BYTES, type TransmittalItem } from "@/lib/transmittals";

const ORG = "org-a";
const KEY = (n: string) => `orgs/${ORG}/docs/${n}.pdf`;
let GOOD: Uint8Array;
let ENCRYPTED: Uint8Array;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function fixtures() {
  const d = await PDFDocument.create();
  d.addPage([400, 300]);
  GOOD = await d.save({ useObjectStreams: false });
  // An owner-password / permission-restricted PDF as pdf-lib sees one: a
  // trailer that names an /Encrypt dictionary (the xref is untouched — the
  // trailer follows it).
  const s = Buffer.from(GOOD).toString("latin1")
    .replace(/trailer\s*<</, (m) => `${m}\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>`);
  ENCRYPTED = new Uint8Array(Buffer.from(s, "latin1"));
}

function file(doc: string, opts: { bytes?: Uint8Array; size?: number | null; contentLength?: number; key?: string } = {}) {
  const key = opts.key ?? KEY(doc);
  st.docs[doc] = { id: doc, current_version_id: `${doc}-v` };
  st.versions[`${doc}-v`] = { id: `${doc}-v`, file_url: key, size: opts.size === undefined ? (opts.bytes ?? GOOD).byteLength : opts.size };
  st.objects[key] = { bytes: opts.bytes ?? GOOD, ...(opts.contentLength !== undefined ? { ContentLength: opts.contentLength } : {}) };
}
const item = (doc: string, number = doc.toUpperCase()): TransmittalItem => ({ documentId: doc, number });

beforeEach(async () => {
  if (!GOOD) await fixtures();
  st.docs = {}; st.versions = {}; st.readErrors = {}; st.objects = {}; st.fetched = []; st.destroyed = 0; st.writes = [];
  st.user = { id: "u-dc" };
  st.transmittal = null;
  st.authority = { allowed: true, member: { role: "DocCtrl", roles: ["DocCtrl"], email: "dc@a" } };
});

const run = (items: TransmittalItem[], now?: () => number) =>
  checkItemsStampable(admin.client as never, { orgId: ORG, items, ...(now ? { now } : {}) });

describe("TRX-16 — checkItemsStampable runs the portal's stamp test on the file the issue will pin", () => {
  it("a PDF pdf-lib loads and stamps is stampable — REGRESSION: an ordinary issue is not warned", async () => {
    file("d1");
    expect(await run([item("d1", "P-101")])).toEqual([{ documentId: "d1", number: "P-101", verdict: "stampable" }]);
    expect(st.fetched).toEqual([KEY("d1")]);
    expect(st.writes).toEqual([]); // read-only
  });
  it("an ENCRYPTED (permission-restricted) PDF is unloadable — the portal's plain load refuses it", async () => {
    await expect(PDFDocument.load(ENCRYPTED)).rejects.toThrow(/is encrypted/); // the fixture is what the portal meets
    file("d2", { bytes: ENCRYPTED });
    expect(await run([item("d2", "VDS-7")])).toEqual([{ documentId: "d2", number: "VDS-7", verdict: "unloadable", detail: "encrypted (permission-restricted) PDF" }]);
  });
  it("a PDF over the portal's bound is oversize by its recorded size — never fetched", async () => {
    file("d3", { size: PORTAL_STAMP_MAX_BYTES + 1 });
    expect(await run([item("d3")])).toEqual([{ documentId: "d3", number: "D3", verdict: "oversize" }]);
    expect(st.fetched).toEqual([]);
  });
  it("…or by the object's length when no size is recorded — the body is released unread", async () => {
    file("d4", { size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    expect((await run([item("d4")]))[0].verdict).toBe("oversize");
    expect(st.destroyed).toBe(1);
    // exactly AT the bound is still stamped (the portal's `>`)
    file("d5", { size: PORTAL_STAMP_MAX_BYTES });
    st.objects[KEY("d5")] = { bytes: GOOD };
    expect((await run([item("d5")]))[0].verdict).toBe("stampable");
  });
  it("a file that is not a PDF is not_pdf (the portal releases it unmarked and its page says so) — not a warning", async () => {
    file("d6", { bytes: PNG });
    expect((await run([item("d6")]))[0].verdict).toBe("not_pdf");
  });
  it("what the check cannot decide is unchecked, with why — and a key outside the workspace is never fetched", async () => {
    st.docs.d7 = { id: "d7", current_version_id: null };
    file("d8", { key: "orgs/org-b/docs/x.pdf" });
    file("d9");
    delete st.objects[KEY("d9")];
    const out = await run([item("d7"), item("d8"), item("d9"), item("missing")]);
    expect(out.map((c) => [c.documentId, c.verdict, c.detail])).toEqual([
      ["d7", "unchecked", "no published file to check"],
      ["d8", "unchecked", "the stored file is outside this workspace"],
      ["d9", "unchecked", "the file could not be fetched"],
      ["missing", "unchecked", "no published file to check"],
    ]);
    expect(st.fetched).not.toContain("orgs/org-b/docs/x.pdf");
    st.readErrors.documents = { message: "timeout" };
    expect((await run([item("d9")]))[0]).toMatchObject({ verdict: "unchecked", detail: "the document could not be read" });
  });
  it("a document listed twice is checked once; past the time budget the rest is unchecked (no fetch)", async () => {
    file("d1"); file("d2");
    let t = 0;
    const out = await run([item("d1"), item("d1"), item("d2")], () => t);
    expect(out.map((c) => c.documentId)).toEqual(["d1", "d2"]);
    st.fetched = [];
    const clock = [0, 0, STAMP_CHECK_TIME_BUDGET_MS + 1];
    const late = await run([item("d1"), item("d2")], () => (clock.length > 1 ? clock.shift()! : clock[0]));
    expect(late[1]).toMatchObject({ verdict: "unchecked", detail: "not checked — the check ran out of time" });
    t = 0;
  });
  it("the bound is the portal route's own (a route module cannot export it — pinned equal)", () => {
    const route = readFileSync(join(process.cwd(), "app/api/transmittal/route.ts"), "utf8");
    const m = /const PORTAL_STAMP_MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(route);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1024 * 1024).toBe(PORTAL_STAMP_MAX_BYTES);
    // and the check makes the portal's call: a plain load, no ignoreEncryption
    const lib = readFileSync(join(process.cwd(), "lib/transmittalStampCheck.ts"), "utf8");
    expect(lib).toContain("pdfDoc = await PDFDocument.load(bytes);");
    expect(lib).not.toMatch(/ignoreEncryption\s*:/);
    expect(route).toContain("const pdfDoc = await PDFDocument.load(source);");
  });
});

describe("TRX-16 — /api/transmittal/stamp-check", () => {
  const post = async (body: unknown, auth = "Bearer jwt") => {
    const { POST } = await import("@/app/api/transmittal/stamp-check/route");
    return POST(new NextRequest("https://app/api/transmittal/stamp-check", {
      method: "POST", headers: auth ? { authorization: auth, "content-type": "application/json" } : { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  };
  const draft = (over: Row = {}): Row => ({ id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "draft", recipient_name: "Acme", items: [{ documentId: "d1", number: "P-101" }, { documentId: "d2", number: "VDS-7" }], ...over });

  it("answers each item's verdict for a draft, to a transmit authority — no-store, nothing written", async () => {
    file("d1"); file("d2", { bytes: ENCRYPTED });
    st.transmittal = draft();
    const res = await post({ transmittalId: "t1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).items.map((c: Row) => [c.number, c.verdict])).toEqual([["P-101", "stampable"], ["VDS-7", "unloadable"]]);
    expect(st.writes).toEqual([]);
  });
  it("refuses: no session 401; not a member 404 (no oracle); no transmit authority 403; not a draft 409; unknown 404; a policy that cannot be read 503", async () => {
    st.transmittal = draft();
    expect((await post({ transmittalId: "t1" }, "")).status).toBe(401);
    st.user = null;
    expect((await post({ transmittalId: "t1" })).status).toBe(401);
    st.user = { id: "u-x" };
    st.authority = { allowed: false, member: null };
    expect((await post({ transmittalId: "t1" })).status).toBe(404);
    st.authority = { allowed: false, member: { role: "Viewer", roles: ["Viewer"], email: null } };
    expect((await post({ transmittalId: "t1" })).status).toBe(403);
    st.authority = { allowed: false, member: null, error: "Couldn't read the capability policy: down" };
    expect((await post({ transmittalId: "t1" })).status).toBe(503);
    st.authority = { allowed: true, member: { role: "DocCtrl", roles: ["DocCtrl"], email: null } };
    st.transmittal = draft({ status: "issued" });
    expect((await post({ transmittalId: "t1" })).status).toBe(409);
    st.transmittal = null;
    expect((await post({ transmittalId: "t1" })).status).toBe(404);
    expect((await post({})).status).toBe(400);
    expect(st.fetched).toEqual([]);
  });
});
