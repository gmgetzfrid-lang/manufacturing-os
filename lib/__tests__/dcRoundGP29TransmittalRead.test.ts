// document-control Round G — P29 TRANSMITTAL READ: DIST-18 limb (a) (HIGH),
// under the integrator's rulings (DEC-90 R2, the P27 merge, 2026-10-20):
//   1. every browser reader of transmittals reads through the register route
//      and its per-viewer redaction (redactTransmittalForViewer over the I-12
//      predicate) — the Inspector's trail, getTransmittal, global search, the
//      project evidence pack — so each viewer sees exactly what the register
//      shows them; the sender, controllers and full readers see everything
//      they see today (REGRESSION, pinned per reader);
//   2. no browser read names portal_token any more (the browser's own write
//      paths read back TRANSMITTAL_CLIENT_COLUMNS), so 20261231 can take
//      SELECT on the column away from client roles (its shape is pinned here;
//      its runtime cases are lib/__tests__/rls/dcP29TransmittalTokenColumn.test.ts);
//   3. the outside recipient's portal and the issue / void / revoke / receipt
//      flows are unchanged (dcRoundFTransmittals.test.ts, transmittalPortalRoute.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  user: { id: "u-viewer" } as { id: string } | null,
  principal: null as unknown,
  readable: new Set<string>() as Set<string>,
  readableCalls: [] as Array<{ uid: string; ids: string[] }>,
  readableThrows: false,
  rows: [] as Row[],
  ops: [] as Array<[string, unknown[]]>,
  queries: [] as Array<Array<[string, unknown[]]>>,
  ignoreFilters: false,
  browserReads: [] as string[],
  projectRow: { id: "p1", org_id: "11111111-1111-4111-8111-111111111111", name: "Unit 3 turnaround" } as Row | null,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  const chain = (ops: Array<[string, unknown[]]>): unknown => {
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            let rows = s.rows.filter((r) => ops.filter(([n]) => n === "eq").every(([, a]) => r[a[0] as string] === a[1]));
            const contains = ops.find(([n]) => n === "contains");
            if (contains) {
              const want = (JSON.parse(String(contains[1][1])) as Array<{ documentId: string }>)[0].documentId;
              rows = rows.filter((r) => (r.items as Array<{ documentId: string }>).some((i) => i.documentId === want));
            }
            if (ops.some(([n]) => n === "or")) throw new Error("the register route must never put request text into .or()");
            const ilike = ops.find(([n]) => n === "ilike");
            if (ilike && !s.ignoreFilters) {
              // col ILIKE '%<LIKE-escaped q>%' — one filter value
              const pat = String(ilike[1][1]);
              const q = pat.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
              rows = rows.filter((r) => String(r[ilike[1][0] as string] ?? "").toLowerCase().includes(q));
            }
            const order = ops.find(([n]) => n === "order");
            const asc = (order?.[1][1] as { ascending?: boolean } | undefined)?.ascending !== false;
            rows = [...rows].sort((a, b) => (asc ? 1 : -1) * (Number(a.seq) - Number(b.seq)));
            const limit = ops.find(([n]) => n === "limit");
            if (limit) rows = rows.slice(0, Number(limit[1][0]));
            res({ data: rows, error: null });
          };
        }
        return (...args: unknown[]) => { ops.push([prop, args]); return new Proxy(c, h); };
      },
    };
    return new Proxy(c, h);
  };
  return {
    supabaseAdmin: {
      from: (t: string) => { const ops: Array<[string, unknown[]]> = [["from", [t]]]; s.ops = ops; s.queries.push(ops); return chain(ops); },
      auth: { getUser: async () => ({ data: { user: s.user }, error: s.user ? null : { message: "bad jwt" } }) },
    },
  };
});
vi.mock("@/lib/knowledgeAccess", async (orig) => {
  const real = await orig<typeof import("@/lib/knowledgeAccess")>();
  return {
    ...real,
    loadPrincipal: vi.fn(async () => s.principal),
    readableControlledDocIds: vi.fn(async (p: { uid: string }, ids: string[]) => {
      s.readableCalls.push({ uid: p.uid, ids });
      if (s.readableThrows) throw new real.DcLandscapeUnreadableError("documents", "read failed");
      return new Set([...s.readable].filter((d) => ids.includes(d)));
    }),
  };
});
vi.mock("@/lib/supabase", () => {
  // The browser client: transmittals are never read with it by these readers;
  // the project evidence pack's other reads answer empty (the project row aside).
  const chain = (table: string): unknown => {
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
        return () => {
          if (prop === "maybeSingle") return Promise.resolve({ data: table === "projects" ? s.projectRow : null, error: null });
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  return {
    supabase: {
      from: (t: string) => { s.browserReads.push(t); if (t === "transmittals") throw new Error("a browser read of transmittals"); return chain(t); },
      auth: { getSession: async () => ({ data: { session: { access_token: "jwt-test" } } }) },
    },
  };
});

import { GET } from "@/app/api/transmittal/register/route";
import {
  listTransmittalsForDocument, listTransmittalsForProject, searchTransmittalsForViewer, getTransmittal, transmittalForViewer,
  sendTransmittalEmail, hasPortalLink, redactTransmittalForViewer, rowToTransmittal, RESTRICTED_DOCUMENT_LABEL,
  TRANSMITTAL_CLIENT_COLUMNS, TRANSMITTAL_SEARCH_MAX, type Transmittal,
} from "@/lib/transmittals";
import { gatherProjectEvidence, renderProjectEvidenceHtml, transmittalEvidenceRow } from "@/lib/evidencePack";
import { globalSearch } from "@/lib/globalSearch";

vi.mock("@/lib/search", () => ({
  lookupTag: vi.fn(async () => []),
  searchDocuments: vi.fn(async () => []),
  searchAssets: vi.fn(async () => []),
  searchTickets: vi.fn(async () => []),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const T7 = "22222222-2222-4222-8222-222222222222";
const T6 = "33333333-3333-4333-8333-333333333333";
const T5 = "44444444-4444-4444-8444-444444444444";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";   // the restricted P&ID
const OPEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";  // an open drawing
const PROJ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const row = (over: Row = {}): Row => ({
  id: T7, org_id: ORG, project_id: PROJ, seq: 7, number: "TR-0007", status: "acknowledged", purpose: "For Construction",
  subject: "Unit 3 HF alkylation relief package", notes: "PID-4412 Rev C supersedes Rev B",
  recipient_name: "Jane Doe", recipient_company: "BuildCo", recipient_email: "jane@buildco.com",
  created_by: "u-sender", issued_at: "2026-10-01T00:00:00Z", acknowledged_at: "2026-10-02T00:00:00Z", acknowledged_by_name: "Jane Doe",
  acknowledged_via: "portal", acknowledged_meta: { ip: "203.0.113.9", note: "Got PID-4412" },
  portal_token: "tok-secret-0007", portal_expires_at: "2099-01-01T00:00:00Z",
  items: [
    { documentId: PID, number: "PID-4412", title: "Unit 3 HF alkylation relief system", rev: "C", fileHash: "abc123def456aa", statusAsSent: "Issued" },
    { documentId: OPEN, number: "P-101", title: "Feed pump layout", rev: "B" },
  ],
  ...over,
});
const principalOf = (over: Row = {}) => ({ uid: "u-viewer", orgId: ORG, role: "Viewer", roles: ["Viewer"], isController: false, teamIds: [], ...over });
const req = (qs: string) => new NextRequest(`https://app/api/transmittal/register?${qs}`, { headers: { authorization: "Bearer jwt" } });
const served = async (qs: string) => {
  const res = await GET(req(qs));
  return { status: res.status, body: (await res.json()) as { transmittals?: Transmittal[]; error?: string } };
};

beforeEach(() => {
  s.user = { id: "u-viewer" };
  s.principal = principalOf();
  s.readable = new Set([OPEN]);
  s.readableCalls = [];
  s.readableThrows = false;
  s.rows = [
    row(),
    row({ id: T6, seq: 6, number: "TR-0006", subject: "Pump drawings", items: [{ documentId: OPEN, number: "P-101", rev: "A" }], portal_token: "tok-0006", acknowledged_meta: { ip: "203.0.113.9", note: "Received" } }),
    row({ id: T5, seq: 5, number: "TR-0005", project_id: null, subject: "Other", items: [{ documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", number: "X-1" }] }),
  ];
  s.ops = [];
  s.queries = [];
  s.ignoreFilters = false;
  s.browserReads = [];
});

describe("DIST-18 limb (a) — the register route serves each browser reader's slice, redacted for the viewer", () => {
  it("documentId (the Inspector's trail): the rows listing that document, 50 newest, select * with the service role — a Viewer outside the P&ID's ACL sees it restricted and no token", async () => {
    const { status, body } = await served(`orgId=${ORG}&documentId=${OPEN}`);
    expect(status).toBe(200);
    expect(s.ops).toEqual(expect.arrayContaining([["select", ["*"]], ["eq", ["org_id", ORG]], ["contains", ["items", JSON.stringify([{ documentId: OPEN }])]], ["order", ["seq", { ascending: false }]], ["limit", [50]]]));
    expect(body.transmittals!.map((t) => t.number)).toEqual(["TR-0007", "TR-0006"]);
    const [t7, t6] = body.transmittals!;
    expect(t7.items[0]).toMatchObject({ number: RESTRICTED_DOCUMENT_LABEL, restricted: true });
    expect(t7.items[1]).toMatchObject({ number: "P-101", rev: "B" });
    expect(t7.portalToken).toBeNull();
    expect(JSON.stringify(t7)).not.toMatch(/PID-4412|tok-secret|HF alkylation/);
    // REGRESSION: the transmittal the viewer may read whole is served whole, token included
    expect(t6.portalToken).toBe("tok-0006");
    expect(t6.subject).toBe("Pump drawings");
  });

  it("review minor: the documentId slice answers only about a document this viewer may read — never a membership oracle on a private document's id; a decision that cannot be made answers 503, never the rows", async () => {
    // a Viewer outside the private P&ID's ACL asks about it by id: no row, and no transmittals read at all
    const asked = await served(`orgId=${ORG}&documentId=${PID}`);
    expect(asked).toEqual({ status: 200, body: { transmittals: [] } });
    expect(s.queries).toEqual([]);
    expect(s.readableCalls).toEqual([{ uid: "u-viewer", ids: [PID] }]);
    // … a document id that names nothing answers the same as a private one
    expect((await served(`orgId=${ORG}&documentId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`)).body).toEqual({ transmittals: [] });
    // REGRESSION: the same Viewer asking about a document they may read gets its trail
    expect((await served(`orgId=${ORG}&documentId=${OPEN}`)).body.transmittals!.map((t) => t.number)).toEqual(["TR-0007", "TR-0006"]);
    // REGRESSION: a reader of the P&ID (an Engineer in its ACL) gets the P&ID's trail
    s.readable = new Set([PID]);
    expect((await served(`orgId=${ORG}&documentId=${PID}`)).body.transmittals!.map((t) => t.number)).toEqual(["TR-0007"]);
    // REGRESSION: a controller is answered before any read decision (DEC-43)
    s.user = { id: "u-dc" };
    s.principal = principalOf({ uid: "u-dc", role: "DocCtrl", roles: ["DocCtrl"], isController: true });
    s.readable = new Set();
    s.readableCalls = [];
    expect((await served(`orgId=${ORG}&documentId=${PID}`)).body.transmittals!.map((t) => t.number)).toEqual(["TR-0007"]);
    expect(s.readableCalls).toEqual([]);
    // fail closed: the read decision cannot be made → 503 "try again", no row
    s.user = { id: "u-viewer" };
    s.principal = principalOf();
    s.readableThrows = true;
    s.queries = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = await served(`orgId=${ORG}&documentId=${OPEN}`);
    warn.mockRestore();
    expect(failed.status).toBe(503);
    expect(failed.body.transmittals).toBeUndefined();
    expect(s.queries).toEqual([]);
  });

  it("REGRESSION per reader: the sender and a controller get every row whole, as the browser read did", async () => {
    s.user = { id: "u-sender" };
    s.principal = principalOf({ uid: "u-sender" });
    s.readable = new Set([OPEN, PID]);
    const sender = (await served(`orgId=${ORG}&documentId=${OPEN}`)).body.transmittals!;
    expect(sender[0]).toMatchObject({ portalToken: "tok-secret-0007", subject: "Unit 3 HF alkylation relief package" });
    expect(sender[0].items.map((i) => i.number)).toEqual(["PID-4412", "P-101"]);
    s.user = { id: "u-dc" };
    s.principal = principalOf({ uid: "u-dc", role: "DocCtrl", roles: ["DocCtrl"], isController: true });
    s.readableCalls = [];
    const ctl = (await served(`orgId=${ORG}&projectId=${PROJ}`)).body.transmittals!;
    expect(ctl.map((t) => [t.number, t.portalToken, t.items[0].number])).toEqual([["TR-0006", "tok-0006", "P-101"], ["TR-0007", "tok-secret-0007", "PID-4412"]]);
    expect(s.readableCalls).toEqual([]);
  });

  it("projectId (the evidence pack): the project's rows, oldest first, 500 at most", async () => {
    const { body } = await served(`orgId=${ORG}&projectId=${PROJ}`);
    expect(s.ops).toEqual(expect.arrayContaining([["eq", ["project_id", PROJ]], ["order", ["seq", { ascending: true }]], ["limit", [500]]]));
    expect(body.transmittals!.map((t) => t.number)).toEqual(["TR-0006", "TR-0007"]);
  });

  it("q (global search): the browser's own filter, newest first; a subject the register withholds is neither returned nor matched; the number and recipient still match", async () => {
    const hit = (await served(`orgId=${ORG}&q=alkylation`)).body.transmittals!;
    expect(hit).toEqual([]); // only TR-0007's (withheld) subject says it
    const byNumber = (await served(`orgId=${ORG}&q=TR-0007`)).body.transmittals!;
    expect(byNumber.map((t) => [t.number, t.subject])).toEqual([["TR-0007", null]]);
    const byRecipient = (await served(`orgId=${ORG}&q=buildco&limit=2`)).body.transmittals!;
    expect(byRecipient.map((t) => t.number)).toEqual(["TR-0007", "TR-0006"]);
    // one read per column, each with the text as ONE ilike value, bounded to the org, newest first
    const last4 = s.queries.slice(-4);
    expect(last4.map((ops) => ops.find(([n]) => n === "ilike"))).toEqual([
      ["ilike", ["number", "%buildco%"]], ["ilike", ["subject", "%buildco%"]],
      ["ilike", ["recipient_name", "%buildco%"]], ["ilike", ["recipient_company", "%buildco%"]]]);
    for (const ops of last4) expect(ops).toEqual(expect.arrayContaining([["select", ["*"]], ["eq", ["org_id", ORG]], ["order", ["seq", { ascending: false }]], ["limit", [50]]]));
  });

  it("BLOCKER (review): search text never becomes a filter term — q='zz,portal_token.like.a*' asks no .or() and names no portal_token; LIKE's own characters are escaped", async () => {
    s.rows.push(row({ id: "66666666-6666-4666-8666-666666666666", seq: 8, number: "TR-0008", subject: null, portal_token: "abcdef0123456789", recipient_name: "Ann", recipient_company: "Acme" }));
    const res = await served(`orgId=${ORG}&q=${encodeURIComponent("zz,portal_token.like.a*")}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.transmittals).toEqual([]);
    const all = s.queries.flat();
    expect(all.some(([n]) => n === "or")).toBe(false);
    expect(JSON.stringify(all.filter(([n]) => n !== "ilike")).includes("portal_token")).toBe(false);
    expect(all.filter(([n]) => n === "ilike").map(([, a]) => a[0])).toEqual(["number", "subject", "recipient_name", "recipient_company"]);
    // the whole text is one value; a trailing backslash, % and _ are literal
    expect(all.find(([n]) => n === "ilike")![1][1]).toBe("%zz,portal\\_token.like.a*%"); // its comma is just a character of the value
    s.queries = [];
    await served(`orgId=${ORG}&q=${encodeURIComponent("50%_a\\")}`);
    expect(s.queries.flat().find(([n]) => n === "ilike")![1][1]).toBe("%50\\%\\_a\\\\%");
  });

  it("BLOCKER (review): even if the database matched on something the viewer is not shown, a subject-less restricted row is returned only when q is in its number or recipient", async () => {
    // a restricted, subject-less transmittal (the shape the composer stores for an empty subject)
    s.rows = [row({ id: "66666666-6666-4666-8666-666666666666", seq: 8, number: "TR-0008", subject: null, portal_token: "abcdef0123456789", recipient_name: "Ann", recipient_company: "Acme" })];
    s.ignoreFilters = true; // the database answers every row, whatever the filter
    expect((await served(`orgId=${ORG}&q=${encodeURIComponent("qqzzqq,portal_token.like.a*")}&limit=50`)).body.transmittals).toEqual([]);
    expect((await served(`orgId=${ORG}&q=qqzzqq`)).body.transmittals).toEqual([]);
    // REGRESSION: its number and recipient still find it, the token withheld
    const byName = (await served(`orgId=${ORG}&q=acme`)).body.transmittals!;
    expect(byName.map((t) => [t.number, t.portalToken])).toEqual([["TR-0008", null]]);
    // the sender sees it whole and still finds it by number
    s.user = { id: "u-sender" };
    s.principal = principalOf({ uid: "u-sender" });
    expect((await served(`orgId=${ORG}&q=tr-0008`)).body.transmittals!.map((t) => t.number)).toEqual(["TR-0008"]);
    expect((await served(`orgId=${ORG}&q=zzzz`)).body.transmittals).toEqual([]);
  });

  it("merges the per-column reads by id: a row matching on two columns is one hit, newest first", async () => {
    s.readable = new Set([OPEN, PID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    s.rows = [row({ subject: "Jane's package" })];
    const hits = (await served(`orgId=${ORG}&q=jane`)).body.transmittals!;
    expect(hits.map((t) => t.number)).toEqual(["TR-0007"]);
  });

  it("REGRESSION: a viewer who may read every item finds a transmittal by its subject, as before (default 5 hits)", async () => {
    s.readable = new Set([OPEN, PID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    const hit = (await served(`orgId=${ORG}&q=alkylation`)).body.transmittals!;
    expect(hit.map((t) => [t.number, t.subject])).toEqual([["TR-0007", "Unit 3 HF alkylation relief package"]]);
    s.rows = Array.from({ length: 9 }, (_, i) => row({ id: `00000000-0000-4000-8000-00000000000${i}`, seq: i + 1, number: `TR-000${i + 1}`, items: [] }));
    expect((await served(`orgId=${ORG}&q=relief`)).body.transmittals!.map((t) => t.number)).toEqual(["TR-0009", "TR-0008", "TR-0007", "TR-0006", "TR-0005"]);
  });

  it("refuses a malformed slice (400) — a bad id, two slices at once, a short query, a limit out of range — before any read", async () => {
    for (const qs of [`orgId=${ORG}&documentId=nope`, `orgId=${ORG}&projectId=nope`, `orgId=${ORG}&documentId=${OPEN}&projectId=${PROJ}`,
      `orgId=${ORG}&id=${T7}&q=pump`, `orgId=${ORG}&q=p`, `orgId=${ORG}&q=${"x".repeat(201)}`, `orgId=${ORG}&q=pump&limit=0`, `orgId=${ORG}&q=pump&limit=51`]) {
      s.ops = [];
      expect((await served(qs)).status, qs).toBe(400);
      expect(s.ops.some(([n, a]) => n === "from" && a[0] === "transmittals"), qs).toBe(false);
    }
    s.principal = null;
    expect((await served(`orgId=${ORG}&documentId=${OPEN}`)).status).toBe(403);
  });
});

describe("DIST-18 limb (a) — the browser readers ask the route, never the table", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // the route, answering as the server would for this viewer
    fetchMock.mockImplementation(async (url: string) => {
      const u = new URL(String(url), "https://app");
      return GET(new NextRequest(`https://app${u.pathname}${u.search}`, { headers: { authorization: "Bearer jwt" } }));
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("listTransmittalsForDocument (the Inspector's trail) and getTransmittal read the register's view", async () => {
    const trail = await listTransmittalsForDocument(ORG, OPEN);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/transmittal/register?orgId=${ORG}&documentId=${OPEN}`);
    expect(trail.map((t) => t.number)).toEqual(["TR-0007", "TR-0006"]);
    // the trail's own document is readable: its revision is shown, as before
    expect(trail[0].items.find((i) => i.documentId === OPEN)?.rev).toBe("B");
    expect(trail[0].portalToken).toBeNull();
    const one = await getTransmittal(T6, ORG);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`/api/transmittal/register?orgId=${ORG}&id=${T6}`);
    expect(one?.portalToken).toBe("tok-0006");
    expect(await getTransmittal("55555555-5555-4555-8555-555555555555", ORG)).toBeNull();
    expect(s.browserReads).not.toContain("transmittals");
  });

  it("searchTransmittalsForViewer → globalSearch: the register's hits, the recipient as subtitle where the subject is withheld; any refusal answers none (search never fails the palette)", async () => {
    const hits = (await globalSearch({ orgId: ORG, query: "buildco" })).filter((h) => h.kind === "transmittal");
    expect(hits.map((h) => [h.title, h.subtitle, h.badge])).toEqual([["TR-0007", "Jane Doe", "acknowledged"], ["TR-0006", "Pump drawings", "acknowledged"], ["TR-0005", "Jane Doe", "acknowledged"]]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/transmittal/register?orgId=${ORG}&q=buildco&limit=5`);
    // review minor: a query longer than the route takes searches on its first 200 characters, never "no transmittals"
    const long = `buildco ${"y".repeat(300)}`;
    fetchMock.mockClear();
    await searchTransmittalsForViewer(ORG, long, 5);
    const sent = new URL(String(fetchMock.mock.calls[0][0]), "https://app").searchParams.get("q")!;
    expect(sent).toBe(long.slice(0, TRANSMITTAL_SEARCH_MAX));
    expect(TRANSMITTAL_SEARCH_MAX).toBe(200);
    expect((await fetchMock.mock.results[0].value as Response).status).toBe(200);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "x" }), { status: 503 }));
    expect(await searchTransmittalsForViewer(ORG, "buildco", 5)).toEqual([]);
    expect(s.browserReads).not.toContain("transmittals");
  });

  it("the project evidence pack prints each transmittal as the register shows the viewer: a restricted item is 'Restricted document', the withheld receipt note is absent; the rest as before", async () => {
    const pack = await gatherProjectEvidence(PROJ);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/transmittal/register?orgId=${ORG}&projectId=${PROJ}`);
    const html = renderProjectEvidenceHtml(pack);
    expect(html).toContain("TR-0007");
    expect(html).toContain(RESTRICTED_DOCUMENT_LABEL);
    expect(html).toContain("P-101 RB");
    expect(html).not.toMatch(/PID-4412|abc123def456|Got PID/);
    expect(html).toMatch(/Jane Doe · .* \(portal · from 203\.0\.113\.9\)/);
    expect(s.browserReads).not.toContain("transmittals");
  });

  it("REGRESSION: for a viewer who may read every item the pack prints every item as sent — revision, status and hash prefix — and the receipt note", async () => {
    s.readable = new Set([OPEN, PID]);
    const html = renderProjectEvidenceHtml(await gatherProjectEvidence(PROJ));
    expect(html).toContain("PID-4412 RC (Issued) #abc123def456");
    expect(html).toContain("note: “Got PID-4412”");
    expect(html).not.toContain(RESTRICTED_DOCUMENT_LABEL);
  });

  it("a pack whose transmittals cannot be read says so, never 'No transmittals'", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "Couldn't load the transmittal register — try again." }), { status: 500 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = renderProjectEvidenceHtml(await gatherProjectEvidence(PROJ));
    warn.mockRestore();
    expect(html).toContain("The transmittals could not be read — left out, not absent.");
    expect(html).not.toContain("No transmittals tied to this project.");
    // a database without the table answers none, as before
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "x", missingTable: true }), { status: 404 }));
    expect(await listTransmittalsForProject(ORG, PROJ)).toEqual([]);
  });

  it("transmittalEvidenceRow keeps the pack's row shape", () => {
    const t = rowToTransmittal(row());
    expect(transmittalEvidenceRow(t)).toMatchObject({ number: "TR-0007", recipient_company: "BuildCo", acknowledged_via: "portal", acknowledged_meta: { ip: "203.0.113.9" } });
  });
});

describe("DIST-18 limb (a) — whether a link exists, without the browser holding the token", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const full = () => rowToTransmittal(row({ status: "issued" }));

  it("hasPortalLink: the token, or the register's word that it was withheld", () => {
    expect(hasPortalLink(full())).toBe(true);
    const withheld = redactTransmittalForViewer(full(), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    expect(withheld.portalToken).toBeNull();
    expect(hasPortalLink(withheld)).toBe(true);
    expect(hasPortalLink({ ...full(), portalToken: null })).toBe(false);
  });

  it("transmittalForViewer's fallback (the register could not be asked) for a row read back without the token column: an issued row's link is withheld 'unchecked', never 'none'; a draft has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const issued = await transmittalForViewer({ ...full(), portalToken: null });
    const draft = await transmittalForViewer({ ...full(), status: "draft", portalToken: null });
    warn.mockRestore();
    expect(issued.viewer).toMatchObject({ portalWithheld: true, portalWithheldReason: "unchecked", accessUnchecked: true });
    expect(draft.viewer).toMatchObject({ portalWithheld: false, portalWithheldReason: null });
  });

  it("sendTransmittalEmail: a withheld link is still emailed to the recipient by the route (which reads the token server-side); a row with no link is not", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const actor = { orgId: ORG, actorUserId: "u-dc" };
    const withheld = redactTransmittalForViewer(full(), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    expect(await sendTransmittalEmail(withheld, actor)).toEqual({ sent: true, reason: null });
    expect(f).toHaveBeenCalledTimes(1);
    const none = await sendTransmittalEmail({ ...full(), portalToken: null }, actor);
    expect(none.sent).toBe(false);
    expect(none.reason).toMatch(/predates 20260910/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ─── The census: no browser read of transmittals names the token or `*` ──────
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!["node_modules", ".next", "__tests__"].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("DIST-18 limb (a) — census: outside the server routes, no read of transmittals selects * or the token", () => {
  it("every .from(\"transmittals\") outside app/api/** names its columns (never `*`, never an empty select, never portal_token)", () => {
    const files = [...walk("lib"), ...walk("components"), ...walk("app")].filter((f) => !f.startsWith("app/api/"));
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/\.from\(\s*["']transmittals["']\s*\)/g)) {
        sites++;
        const stmt = src.slice(m.index!, src.indexOf(";", m.index!)).replace(/\/\/[^\n]*/g, "");
        if (/\.select\(\s*(["'`]\s*\*\s*["'`])?\s*\)/.test(stmt) || /portal_token/.test(stmt)) offenders.push(`${f}:${src.slice(0, m.index!).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(8); // lib/transmittals.ts's own writes and lib/inbox.ts's read
  });

  it("TRANSMITTAL_CLIENT_COLUMNS is every 20260717 column and nothing a later migration added (it answers on any database with the table)", () => {
    const base = readFileSync(join(ROOT, "supabase/migrations/20260717_transmittals.sql"), "utf8");
    const table = base.slice(base.indexOf("CREATE TABLE IF NOT EXISTS transmittals"), base.indexOf(");", base.indexOf("CREATE TABLE IF NOT EXISTS transmittals")));
    const declared = [...table.matchAll(/^\s{2}([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);
    expect(TRANSMITTAL_CLIENT_COLUMNS.split(",").map((c) => c.trim()).sort()).toEqual([...declared].sort());
  });

  it("lib/inbox.ts reads only the sender's own transmittals (created_by = the viewer) — what the register shows its sender whole — and no token", () => {
    const src = readFileSync(join(ROOT, "lib/inbox.ts"), "utf8");
    expect(src).toMatch(/\.from\("transmittals"\)\.select\("id, number, subject, recipient_name, recipient_company, issued_at, items"\)\s*\n\s*\.eq\("org_id", orgId\)\.eq\("created_by", userId\)\.eq\("status", "issued"\)/);
  });

  it("the Inspector's trail and its distribution pill still read through listTransmittalsForDocument (no browser SELECT of their own)", () => {
    const panel = readFileSync(join(ROOT, "components/documents/InspectorPanel.tsx"), "utf8");
    expect(panel.match(/listTransmittalsForDocument\(/g)?.length).toBe(2);
    expect(panel).not.toMatch(/from\(["']transmittals["']\)/);
  });
});

// ─── 20261231's shape (DEC-30; runtime cases in rls/dcP29TransmittalTokenColumn) ─
const MIG = "20261231_dc_roundG_transmittal_token_column.sql";
const sql = readFileSync(join(ROOT, "supabase/migrations", MIG), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const stripSql = (b: string) => b.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
/** The columns 20261231 refuses to run without — each pending file that adds
 *  a transmittals column must be pasted first (review blocker). */
const PASTE_FIRST_COLUMNS: Record<string, string[]> = {
  "20261133": ["portal_expires_at", "portal_revoked_at", "portal_revoked_by", "portal_last_used_at", "portal_open_count", "portal_download_count"],
  "20261199": ["stamp_check"],
};
/** Every column an ALTER TABLE … transmittals statement adds — several per
 *  statement included, with or without the COLUMN keyword. */
function transmittalsColumnsAdded(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?transmittals"?\s+([^;]*)/gi)) {
    for (const a of m[1].matchAll(/(?:^|,)\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      if (!/^(constraint|primary|unique|check|foreign|exclude)$/i.test(a[1])) out.push(a[1].toLowerCase());
    }
  }
  return out;
}
/** audit-reports/MIGRATION-PASTE-ORDER.md §4: a file is LIVE only when every
 *  row naming it says LIVE; an older file (before 20261001) is the shipped
 *  baseline the guide does not list (lib/__tests__/auditExplorerSnapshot.test.ts). */
const PASTE_TAGS = new Map<string, Set<string>>();
for (const line of readFileSync(join(ROOT, "audit-reports/MIGRATION-PASTE-ORDER.md"), "utf8").split("\n")) {
  const m = /^\| \d+[a-z]? (LIVE|PASTE|HOLD|ASK)\b[^|]*\| [^|]*?(\d{8})/.exec(line);
  if (m) PASTE_TAGS.set(m[2], new Set([...(PASTE_TAGS.get(m[2]) ?? []), m[1]]));
}
const isLive = (n: string) => (n < "20261001" ? true : PASTE_TAGS.get(n)?.size === 1 && PASTE_TAGS.get(n)!.has("LIVE"));

describe("20261231 — one paste, DEC-30 shape, a column privilege and nothing else", () => {
  it("TEMP counts-only inventory BEFORE the transaction; one BEGIN / COMMIT; ONE final SELECT (check, ok, n) after it", () => {
    const iTemp = code.indexOf("CREATE TEMP TABLE _dc_g31_before");
    const iBegin = code.indexOf("BEGIN;");
    const iCommit = code.indexOf("COMMIT;");
    expect(iTemp).toBeGreaterThan(-1);
    expect(iTemp).toBeLessThan(iBegin);
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = code.slice(iCommit + "COMMIT;".length);
    expect(tail.match(/^SELECT /gm)).toHaveLength(1);
    expect(tail).toMatch(/^SELECT 'transmittals: RLS still on' AS "check",\s*\n.*AS ok,\s*\n\s*NULL::text AS n/m);
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL, n FROM/);
  });

  it("the inventory is aggregate counts and privilege flags only — never a customer row", () => {
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE"), code.indexOf("BEGIN;"));
    const rowsOut = inv.slice(inv.indexOf("SELECT 1 AS ord")).split(/\nUNION ALL\n/);
    expect(rowsOut).toHaveLength(10);
    for (const r of rowsOut) expect(r, r).toMatch(/COUNT\(\*\)::text|has_(table|any_column)_privilege\('(authenticated|anon)', 'public\.transmittals'/);
    expect(inv).not.toMatch(/string_agg|array_agg|json_agg/);
  });

  it("revokes the table-level SELECT from PUBLIC, anon and authenticated and grants back every column but portal_token — to each role only if it could read the table before; never a table-level grant", () => {
    expect(code).toMatch(/REVOKE SELECT ON TABLE public\.transmittals FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/AND attname <> 'portal_token';/);
    expect(code).toMatch(/v_auth := has_any_column_privilege\('authenticated', 'public\.transmittals', 'SELECT'\);/);
    expect(code).toMatch(/v_anon := has_any_column_privilege\('anon', 'public\.transmittals', 'SELECT'\);/);
    expect(code).toMatch(/IF v_auth THEN\s*\n\s*EXECUTE format\('GRANT SELECT \(%s\) ON TABLE public\.transmittals TO authenticated', v_cols\);/);
    expect(code).toMatch(/IF v_anon THEN\s*\n\s*EXECUTE format\('GRANT SELECT \(%s\) ON TABLE public\.transmittals TO anon', v_cols\);/);
    // the snapshot of who could read is taken BEFORE the revoke
    expect(code.indexOf("v_anon := has_any_column_privilege")).toBeLessThan(code.indexOf("REVOKE SELECT ON TABLE public.transmittals"));
    expect(code).not.toMatch(/GRANT SELECT ON (TABLE )?(public\.)?transmittals TO/);
  });

  it("re-creates no function, policy or trigger and defines no SECURITY DEFINER; refuses without 20260717 / 20260910", () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)|DROP POLICY|SECURITY DEFINER/i);
    expect(code).toMatch(/RAISE EXCEPTION '20261231 needs 20260717/);
    expect(code).toMatch(/RAISE EXCEPTION '20261231 needs 20260910/);
  });

  it("review blocker: refuses, changing nothing, until every pending file that adds a transmittals column is pasted — 20261133's six portal lifecycle columns and 20261199's stamp_check — naming the missing file, BEFORE the revoke", () => {
    for (const col of PASTE_FIRST_COLUMNS["20261133"]) expect(code, col).toMatch(new RegExp(`ARRAY\\[[^\\]]*'${col}'[^\\]]*\\]`));
    expect(code).toMatch(/RAISE EXCEPTION '20261231 needs 20261133 \(the transmittals portal lifecycle columns\) — paste 20261133 first; nothing was changed\.';/);
    expect(code).toMatch(/attname = 'stamp_check'/);
    expect(code).toMatch(/RAISE EXCEPTION '20261231 needs 20261199 \(transmittals\.stamp_check\) — paste 20261199 first/);
    const iRevoke = code.indexOf("REVOKE SELECT ON TABLE public.transmittals");
    expect(code.indexOf("needs 20261133")).toBeLessThan(iRevoke);
    expect(code.indexOf("needs 20261199")).toBeLessThan(iRevoke);
  });

  it("the header states the order (deploy first, then paste — after 20261133 and 20261199, inheriting 20261199's hold), the rollback, and the rule for a later column", () => {
    expect(sql).toMatch(/DEPLOY FIRST, THEN PASTE/);
    expect(sql).toMatch(/PASTE AFTER 20261133 AND 20261199/);
    expect(sql).toMatch(/it inherits 20261199's hold/);
    expect(sql).not.toMatch(/Either order\s*\n?--\s*with every other pending paste: it re-creates/);
    expect(sql).toMatch(/--\s+GRANT SELECT ON transmittals TO anon, authenticated;/);
    expect(sql).toMatch(/A LATER MIGRATION THAT ADDS A COLUMN to transmittals must also/);
  });

  it("tripwire: every migration not yet LIVE that adds a transmittals column (whatever its number, one ALTER adding several included) either grants it to authenticated or is one 20261231 refuses to run before; none re-grants the table-level SELECT (which would re-open the token)", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /^\d{8}_.*\.sql$/.test(f) && f !== MIG).sort();
    const offenders: string[] = [];
    const pending: string[] = [];
    for (const f of files) {
      const n = f.slice(0, 8);
      const body = stripSql(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
      if (n > "20261231" && /GRANT\s+(SELECT|ALL)[^;(]*\bON\s+(TABLE\s+)?(public\.)?transmittals\s+TO/i.test(body)) offenders.push(`${f}: table-level grant`);
      if (isLive(n)) continue;
      const added = transmittalsColumnsAdded(body);
      if (added.length > 0) pending.push(f);
      for (const col of added) {
        const granted = new RegExp(`GRANT\\s+SELECT\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s*ON\\s+(TABLE\\s+)?(public\\.)?transmittals\\s+TO\\s+[^;]*authenticated`, "i").test(body);
        const pastedFirst = (PASTE_FIRST_COLUMNS[n] ?? []).includes(col) && n < "20261231";
        if (!granted && !pastedFirst) offenders.push(`${f}: ${col} neither granted to authenticated nor required by 20261231`);
      }
    }
    expect(offenders).toEqual([]);
    // the scan sees the two files the review named for as long as they are not LIVE
    for (const n of Object.keys(PASTE_FIRST_COLUMNS)) if (!isLive(n)) expect(pending.some((f) => f.startsWith(`${n}_`)), n).toBe(true);
    // every column 20261231 names as a precondition is one that file really adds
    for (const [n, cols] of Object.entries(PASTE_FIRST_COLUMNS)) {
      const f = files.find((x) => x.startsWith(`${n}_`))!;
      expect(transmittalsColumnsAdded(stripSql(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))).sort(), n).toEqual([...cols].sort());
    }
  });

  it("the tripwire's parser reads one ALTER adding several columns, ADD without COLUMN, and skips constraints", () => {
    expect(transmittalsColumnsAdded("ALTER TABLE public.transmittals ADD COLUMN IF NOT EXISTS a_one int, ADD b_two text,\n  ADD CONSTRAINT c_x CHECK (true), ADD COLUMN c_three jsonb;")).toEqual(["a_one", "b_two", "c_three"]);
    expect(transmittalsColumnsAdded("ALTER TABLE IF EXISTS transmittals ALTER COLUMN x SET DEFAULT 0; ALTER TABLE documents ADD COLUMN y int;")).toEqual([]);
  });
});
