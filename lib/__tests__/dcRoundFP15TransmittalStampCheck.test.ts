// document-control Round F wave 3 — P15 SURFACE REMAINDERS: TRX-16, the
// server half. lib/transmittalStampCheck.ts runs the portal's own stamp test
// at ISSUE — a size bound, the first bytes, a pdf-lib load with no
// ignoreEncryption, and the portal's stamp on the loaded (then discarded)
// document — against the file the issue will pin; /api/transmittal/stamp-check
// answers it for a draft, to a transmit authority, read-only.
//
// P15 review fix (the blocker): PDF or not is decided BEFORE the size bound
// — a large CAD model, zip or image is `not_pdf` (released unmarked, never a
// warning), never `oversize`; a non-PDF is never downloaded whole.
// Third review fix: PDF or not is decided by the first four bytes ALONE (a
// RANGED read), as the download route that stamps decides it
// (app/api/transmittal/route.ts `isPdf = looksLikePdf(head)`), never by the
// file's name or recorded type — a real PDF keyed .dwg or typed image/* is
// stamped at download, so it is checked (and an encrypted one warned).
// Final review fix: oversize is decided by the OBJECT's own length (the
// route's ContentLength), never the version's recorded size, and the check
// saves the stamped document as the route does (a save that throws is
// `unloadable`).

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
  objects: {} as Record<string, { ContentLength?: number; bytes: Uint8Array; ignoreRange?: boolean; stream?: boolean; noLength?: boolean }>,
  /** whole-body reads (no Range) */
  fetched: [] as string[],
  /** ranged first-bytes reads (Range: bytes=0-3) */
  heads: [] as string[],
  ranges: [] as string[],
  chunksRead: 0,
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
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { constructor(public input: { Key: string; Range?: string }) {} } }));
/** A streamed body (the Node SDK's): two bytes a chunk, counted as pulled. */
function streamBody(bytes: Uint8Array) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < bytes.length; i += 2) { st.chunksRead++; yield bytes.subarray(i, i + 2); }
    },
    destroy: () => { st.destroyed++; },
  };
}
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: vi.fn(async (cmd: { input: { Key: string; Range?: string } }) => {
      const o = st.objects[cmd.input.Key];
      if (cmd.input.Range) { st.heads.push(cmd.input.Key); st.ranges.push(cmd.input.Range); } else st.fetched.push(cmd.input.Key);
      if (!o) throw new Error("NoSuchKey");
      const total = o.ContentLength ?? o.bytes.byteLength;
      if (cmd.input.Range && !o.ignoreRange) {
        // S3 / R2 refuse a range on an empty object
        if (total === 0) throw Object.assign(new Error("The requested range is not satisfiable"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } });
        const part = o.bytes.subarray(0, 4);
        return {
          ContentLength: part.byteLength,
          // noLength: a store whose ranged answer does not say the total
          ContentRange: `bytes 0-${part.byteLength - 1}/${o.noLength ? "*" : total}`,
          Body: { transformToByteArray: async () => part, destroy: () => { st.destroyed++; } },
        };
      }
      return {
        ...(o.noLength ? {} : { ContentLength: total }),
        Body: o.stream ? streamBody(o.bytes) : { transformToByteArray: async () => o.bytes, destroy: () => { st.destroyed++; } },
      };
    }),
  },
}));
vi.mock("@/lib/transmittals", async (orig) => ({
  ...(await orig<typeof import("@/lib/transmittals")>()),
  evaluateTransmitAuthority: vi.fn(async () => st.authority),
}));

import { checkItemsStampable, STAMP_CHECK_TIME_BUDGET_MS } from "@/lib/transmittalStampCheck";
import { PORTAL_STAMP_MAX_BYTES, describeUnstampable, unstampableItems, type TransmittalItem } from "@/lib/transmittals";

const ORG = "org-a";
const KEY = (n: string) => `orgs/${ORG}/docs/${n}.pdf`;
let GOOD: Uint8Array;
let ENCRYPTED: Uint8Array;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
/** The first bytes of an AutoCAD drawing ("AC1032") and of a zip ("PK\x03\x04"). */
const DWG = new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x33, 0x32, 0, 0, 0, 0]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0]);

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

function file(doc: string, opts: { bytes?: Uint8Array; size?: number | null; contentLength?: number; key?: string; fileType?: string | null; ignoreRange?: boolean; stream?: boolean; noLength?: boolean } = {}) {
  const key = opts.key ?? KEY(doc);
  st.docs[doc] = { id: doc, current_version_id: `${doc}-v` };
  st.versions[`${doc}-v`] = { id: `${doc}-v`, file_url: key, file_type: opts.fileType ?? null, size: opts.size === undefined ? (opts.bytes ?? GOOD).byteLength : opts.size };
  st.objects[key] = {
    bytes: opts.bytes ?? GOOD,
    ...(opts.contentLength !== undefined ? { ContentLength: opts.contentLength } : {}),
    ...(opts.ignoreRange ? { ignoreRange: true } : {}),
    ...(opts.stream ? { stream: true } : {}),
    ...(opts.noLength ? { noLength: true } : {}),
  };
}
const item = (doc: string, number = doc.toUpperCase()): TransmittalItem => ({ documentId: doc, number });

beforeEach(async () => {
  if (!GOOD) await fixtures();
  st.docs = {}; st.versions = {}; st.readErrors = {}; st.objects = {}; st.fetched = []; st.heads = []; st.ranges = []; st.chunksRead = 0; st.destroyed = 0; st.writes = [];
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
    expect(st.heads).toEqual([KEY("d1")]); // its first bytes say PDF (a ranged read) …
    expect(st.ranges).toEqual(["bytes=0-3"]);
    expect(st.fetched).toEqual([KEY("d1")]); // … then it is read whole to load and stamp
    expect(st.writes).toEqual([]); // read-only
  });
  it("an ENCRYPTED (permission-restricted) PDF is unloadable — the portal's plain load refuses it", async () => {
    await expect(PDFDocument.load(ENCRYPTED)).rejects.toThrow(/is encrypted/); // the fixture is what the portal meets
    file("d2", { bytes: ENCRYPTED });
    expect(await run([item("d2", "VDS-7")])).toEqual([{ documentId: "d2", number: "VDS-7", verdict: "unloadable", detail: "encrypted (permission-restricted) PDF" }]);
  });
  it("a PDF over the portal's bound is oversize by the object's own length — only its first bytes are read (to know it is a PDF), never the body", async () => {
    file("d3", { size: PORTAL_STAMP_MAX_BYTES + 1, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    expect(await run([item("d3")])).toEqual([{ documentId: "d3", number: "D3", verdict: "oversize" }]);
    expect(st.heads).toEqual([KEY("d3")]);
    expect(st.fetched).toEqual([]);
  });
  it("…or by the object's length when no size is recorded (the ranged answer's total) — the body is never read", async () => {
    file("d4", { size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    expect((await run([item("d4")]))[0].verdict).toBe("oversize");
    expect(st.heads).toEqual([KEY("d4")]);
    expect(st.fetched).toEqual([]);
    // exactly AT the bound is still stamped (the portal's `>`)
    file("d5", { size: PORTAL_STAMP_MAX_BYTES });
    st.objects[KEY("d5")] = { bytes: GOOD };
    expect((await run([item("d5")]))[0].verdict).toBe("stampable");
  });
  it("a file that is not a PDF is not_pdf (the portal releases it unmarked and its page says so) — not a warning, and never downloaded whole", async () => {
    file("d6", { bytes: PNG });
    const out = await run([item("d6")]);
    expect(out[0].verdict).toBe("not_pdf");
    expect(st.heads).toEqual([KEY("d6")]);
    expect(st.fetched).toEqual([]);
    expect(unstampableItems(out)).toEqual([]);
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
    expect(st.heads).not.toContain("orgs/org-b/docs/x.pdf");
    st.readErrors.documents = { message: "timeout" };
    expect((await run([item("d9")]))[0]).toMatchObject({ verdict: "unchecked", detail: "the document could not be read" });
  });
  it("a document listed twice is checked once; past the time budget the rest is unchecked (no fetch)", async () => {
    file("d1"); file("d2");
    let t = 0;
    const out = await run([item("d1"), item("d1"), item("d2")], () => t);
    expect(out.map((c) => c.documentId)).toEqual(["d1", "d2"]);
    st.fetched = []; st.heads = [];
    // the deadline, then d1's two checks (before its first bytes, before its body) in time; d2's first check late
    const clock = [0, 0, 0, STAMP_CHECK_TIME_BUDGET_MS + 1];
    const late = await run([item("d1"), item("d2")], () => (clock.length > 1 ? clock.shift()! : clock[0]));
    expect(late[0].verdict).toBe("stampable");
    expect(late[1]).toMatchObject({ verdict: "unchecked", detail: "not checked — the check ran out of time" });
    expect(st.heads).toEqual([KEY("d1")]);
    expect(st.fetched).toEqual([KEY("d1")]);
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

describe("TRX-16 (P15 review fix) — PDF or not is decided before the size, by the bytes, as the download route decides it", () => {
  const MODEL_KEY = (n: string, ext: string) => `orgs/${ORG}/docs/${n}.${ext}`;
  it("a .dwg over the bound by its recorded size is not_pdf — only its first four bytes are read, no warning (it was 'oversize: split it')", async () => {
    file("m1", { key: MODEL_KEY("plant", "dwg"), bytes: DWG, size: PORTAL_STAMP_MAX_BYTES + 50 * 1024 * 1024 });
    const out = await run([item("m1", "P-MODEL-1")]);
    expect(out).toEqual([{ documentId: "m1", number: "P-MODEL-1", verdict: "not_pdf" }]);
    expect(st.heads).toEqual([MODEL_KEY("plant", "dwg")]);
    expect(st.ranges).toEqual(["bytes=0-3"]);
    expect(st.fetched).toEqual([]);
    expect(unstampableItems(out)).toEqual([]); // so issueTransmittal raises no UnstampableItemsError
    expect(describeUnstampable(out)).toBeNull();
  });
  it("a .png / .rvt over the bound by the object's length (no size recorded) is not_pdf — never downloaded whole", async () => {
    file("m2", { key: MODEL_KEY("site-photo", "png"), bytes: PNG, size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    file("m3", { key: MODEL_KEY("building", "rvt"), bytes: ZIP, size: null, contentLength: 120 * 1024 * 1024 });
    const out = await run([item("m2"), item("m3")]);
    expect(out.map((c) => c.verdict)).toEqual(["not_pdf", "not_pdf"]);
    expect(st.heads).toEqual([MODEL_KEY("site-photo", "png"), MODEL_KEY("building", "rvt")]);
    expect(st.fetched).toEqual([]);
    expect(unstampableItems(out)).toEqual([]);
  });
  it("a recorded non-PDF type whose bytes are not %PDF is not_pdf — never downloaded whole", async () => {
    file("m4", { key: `orgs/${ORG}/docs/upload-7f3a`, fileType: "image/tiff", bytes: PNG, size: PORTAL_STAMP_MAX_BYTES + 1 });
    expect((await run([item("m4")]))[0].verdict).toBe("not_pdf");
    expect(st.heads).toEqual([`orgs/${ORG}/docs/upload-7f3a`]);
    expect(st.fetched).toEqual([]);
  });
  it("third review fix: a real PDF keyed .dwg or typed image/* is checked as the download route will stamp it — loaded; an ENCRYPTED one warns", async () => {
    file("x1", { key: MODEL_KEY("vendor-drawing", "dwg"), bytes: GOOD });
    file("x2", { key: MODEL_KEY("vendor-datasheet", "dwg"), bytes: ENCRYPTED });
    file("x3", { key: `orgs/${ORG}/docs/scan-11`, fileType: "image/png", bytes: ENCRYPTED });
    const out = await run([item("x1", "VD-1"), item("x2", "VDS-2"), item("x3", "VDS-3")]);
    expect(out).toEqual([
      { documentId: "x1", number: "VD-1", verdict: "stampable" },
      { documentId: "x2", number: "VDS-2", verdict: "unloadable", detail: "encrypted (permission-restricted) PDF" },
      { documentId: "x3", number: "VDS-3", verdict: "unloadable", detail: "encrypted (permission-restricted) PDF" },
    ]);
    expect(st.fetched).toEqual([MODEL_KEY("vendor-drawing", "dwg"), MODEL_KEY("vendor-datasheet", "dwg"), `orgs/${ORG}/docs/scan-11`]);
    // the issuer is warned before anything is sent (it was silently not_pdf, then released unmarked at download)
    expect(unstampableItems(out).map((c) => c.documentId)).toEqual(["x2", "x3"]);
    expect(describeUnstampable(out)).not.toBeNull();
    // …and a %PDF keyed .dwg over the bound is oversize (the route refuses or releases it as oversize too)
    file("x4", { key: MODEL_KEY("big-vendor-set", "dwg"), bytes: GOOD, size: PORTAL_STAMP_MAX_BYTES + 1, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    expect((await run([item("x4")]))[0].verdict).toBe("oversize");
  });
  it("a file its name and type do not settle is told by its first four bytes (a ranged read): a zip over the bound by recorded size or by length is not_pdf, never downloaded", async () => {
    file("m5", { key: `orgs/${ORG}/docs/upload-a1`, fileType: "application/octet-stream", bytes: ZIP, size: PORTAL_STAMP_MAX_BYTES + 1 });
    file("m6", { key: `orgs/${ORG}/docs/upload-a2`, fileType: null, bytes: ZIP, size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    const out = await run([item("m5"), item("m6")]);
    expect(out.map((c) => c.verdict)).toEqual(["not_pdf", "not_pdf"]);
    expect(st.heads).toEqual([`orgs/${ORG}/docs/upload-a1`, `orgs/${ORG}/docs/upload-a2`]);
    expect(st.ranges).toEqual(["bytes=0-3", "bytes=0-3"]);
    expect(st.fetched).toEqual([]);
    expect(unstampableItems(out)).toEqual([]);
  });
  it("…and one at or under the bound is not downloaded whole to read four bytes (the time budget is kept for the PDFs after it)", async () => {
    file("m7", { key: `orgs/${ORG}/docs/upload-a3`, bytes: DWG, size: PORTAL_STAMP_MAX_BYTES });
    file("d1");
    const out = await run([item("m7"), item("d1")]);
    expect(out.map((c) => c.verdict)).toEqual(["not_pdf", "stampable"]);
    expect(st.fetched).toEqual([KEY("d1")]); // only the PDF is read whole
  });
  it("REGRESSION: a %PDF over the bound is still oversize — by the object's length, with or without a recorded size — and still warns", async () => {
    file("p1", { size: PORTAL_STAMP_MAX_BYTES + 1, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    file("p2", { size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1 });
    const out = await run([item("p1"), item("p2")]);
    expect(out.map((c) => c.verdict)).toEqual(["oversize", "oversize"]);
    expect(st.fetched).toEqual([]);
    expect(unstampableItems(out)).toHaveLength(2);
    expect(describeUnstampable(out)).toMatch(/larger than the portal can mark/);
  });
  it("a store that ignores the range answers the whole object: the head is read chunk by chunk and the body released after four bytes", async () => {
    file("s1", { size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1, ignoreRange: true, stream: true });
    file("s2", { key: `orgs/${ORG}/docs/upload-s2`, bytes: ZIP, size: null, contentLength: PORTAL_STAMP_MAX_BYTES + 1, ignoreRange: true, stream: true });
    const out = await run([item("s1"), item("s2")]);
    expect(out.map((c) => c.verdict)).toEqual(["oversize", "not_pdf"]);
    expect(st.chunksRead).toBe(4); // two 2-byte chunks each, never the rest
    expect(st.destroyed).toBe(2);
    expect(st.fetched).toEqual([]);
  });
  it("an empty object (the store refuses a range on zero bytes) is not_pdf, as the portal reads it", async () => {
    file("e1", { bytes: new Uint8Array(), size: 0 });
    expect((await run([item("e1")]))[0].verdict).toBe("not_pdf");
  });
  it("the check decides PDF-or-not by the bytes alone, as the stamping route does — never by name or type", () => {
    const lib = readFileSync(join(process.cwd(), "lib/transmittalStampCheck.ts"), "utf8");
    expect(lib).toContain('.select("id, file_url, size")');
    const code = lib.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("isPdfFile");
    expect(code).not.toContain("file_type");
    expect(lib).toContain('Range: "bytes=0-3"');
    // PDF or not before the bound: the ranged head read precedes any oversize verdict
    const body = lib.slice(lib.indexOf("async function checkOne"));
    expect(body.indexOf("if (!looksLikePdf(first)) return notPdf;")).toBeLessThan(body.indexOf('verdict: "oversize"'));
    // the route that STAMPS decides by the head bytes (its page's listing rule, isPdfFile, is not the stamping rule)
    const route = readFileSync(join(process.cwd(), "app/api/transmittal/route.ts"), "utf8");
    expect(route).toContain("const isPdf = looksLikePdf(head);");
    expect(route).toContain('let unstampedReason: "not_pdf" | "oversize" | "stamp_failed" | null = !isPdf ? "not_pdf" : source ? null : "oversize";');
  });
});

describe("TRX-16 (P15 final review fix) — oversize by the object's own length; the stamped document is saved, as the route does", () => {
  it("a recorded size over the bound with the object under it is NOT oversize — the object is read, loaded and stamped (the route stamps it)", async () => {
    file("r1", { size: PORTAL_STAMP_MAX_BYTES + 50 * 1024 * 1024 }); // the object is GOOD (a few hundred bytes)
    file("r2", { size: PORTAL_STAMP_MAX_BYTES + 1, ignoreRange: true }); // a store that ignores the range: its Content-Length
    const out = await run([item("r1", "P-201"), item("r2", "P-202")]);
    expect(out).toEqual([
      { documentId: "r1", number: "P-201", verdict: "stampable" },
      { documentId: "r2", number: "P-202", verdict: "stampable" },
    ]);
    expect(st.fetched).toEqual([KEY("r1"), KEY("r2")]);
    expect(unstampableItems(out)).toEqual([]); // no false "larger than the portal can mark" warning
  });
  it("neither answer gives the object's length: a recorded size over the bound is unchecked and never read whole; one under it is read and stamped", async () => {
    file("n1", { size: PORTAL_STAMP_MAX_BYTES + 1, noLength: true });
    file("n2", { size: null, noLength: true });
    const out = await run([item("n1"), item("n2")]);
    expect(out.map((c) => [c.documentId, c.verdict, c.detail])).toEqual([
      ["n1", "unchecked", "the stored file's length could not be read, and its recorded size is over the portal's bound — not read whole"],
      ["n2", "stampable", undefined],
    ]);
    expect(st.destroyed).toBeGreaterThanOrEqual(1); // n1's body released unread
    expect(unstampableItems(out)).toEqual([]);
  });
  it("a PDF that loads and stamps but whose save() throws is unloadable — the route's save is inside its stamp try", async () => {
    file("v1");
    const save = vi.spyOn(PDFDocument.prototype, "save").mockRejectedValueOnce(new Error("cannot serialise"));
    try {
      expect(await run([item("v1", "P-301")])).toEqual([
        { documentId: "v1", number: "P-301", verdict: "unloadable", detail: "the PDF could not be stamped (damaged or unsupported)" },
      ]);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      save.mockRestore();
    }
    // REGRESSION: the same file with a working save is stampable
    expect(await run([item("v1", "P-301")])).toEqual([{ documentId: "v1", number: "P-301", verdict: "stampable" }]);
  });
  it("source pins: the bound reads the object's length only, and the check saves inside its stamp try as the route does", () => {
    const lib = readFileSync(join(process.cwd(), "lib/transmittalStampCheck.ts"), "utf8");
    const code = lib.replace(/^\s*\/\/[^\n]*$/gm, "");
    expect(code).toContain("if (total !== null && total > PORTAL_STAMP_MAX_BYTES) {");
    expect(code).not.toMatch(/v\.size > PORTAL_STAMP_MAX_BYTES\) \|\|/);
    const stampTry = code.slice(code.indexOf("await applyStampToPdfDoc(pdfDoc, {"), code.indexOf('detail: "the PDF could not be stamped (damaged or unsupported)"'));
    expect(stampTry).toContain("await pdfDoc.save();");
    const route = readFileSync(join(process.cwd(), "app/api/transmittal/route.ts"), "utf8");
    expect(route).toContain("outBytes = await pdfDoc.save();");
    expect(route).toContain("const size = typeof obj.ContentLength === \"number\" ? obj.ContentLength : null;");
    expect(route).toContain("if (size !== null && size > PORTAL_STAMP_MAX_BYTES) {");
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
