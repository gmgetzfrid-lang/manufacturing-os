// document-control Round G — P27 SHARE REMAINDERS: DIST-17 (HIGH), the
// transmittal register's read, under the integrator's rulings (DEC-90):
//   1. a transmittal's items are shown only to a member the document read
//      predicate (lib/permissions canReadNode, through lib/knowledgeAccess
//      readableControlledDocIds — the I-12 predicate) lets read each item, to
//      its sender, and to controllers; anyone else sees the transmittal and
//      its non-identifying fields, the item as "Restricted document";
//   2. the cover sheet's portal link / QR only for someone who may read every
//      item — otherwise it prints without the link and says why.
// (Ruling 3 — the portal attributes a member's pull to the member — is in
// transmittalPortalRoute.test.ts; the page is rendered in
// dcRoundGP27RegisterRendered.test.ts.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  user: { id: "u-viewer" } as { id: string } | null,
  principal: null as unknown,
  principalThrows: false,
  readable: new Set<string>() as Set<string> | "throw",
  readableCalls: [] as Array<{ uid: string; ids: string[] }>,
  rows: [] as Row[],
  readError: null as null | { code?: string; message: string },
  ops: [] as Array<[string, unknown[]]>,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  const chain = (): unknown => {
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            const idEq = s.ops.find(([n, a]) => n === "eq" && a[0] === "id");
            const rows = idEq ? s.rows.filter((r) => r.id === idEq[1][1]) : s.rows;
            res(s.readError ? { data: null, error: s.readError } : { data: rows, error: null });
          };
        }
        return (...args: unknown[]) => { s.ops.push([prop, args]); return new Proxy(c, h); };
      },
    };
    return new Proxy(c, h);
  };
  return {
    supabaseAdmin: {
      from: (t: string) => { s.ops.push(["from", [t]]); return chain(); },
      auth: { getUser: async () => ({ data: { user: s.user }, error: s.user ? null : { message: "bad jwt" } }) },
    },
  };
});
vi.mock("@/lib/knowledgeAccess", async (orig) => {
  const real = await orig<typeof import("@/lib/knowledgeAccess")>();
  return {
    ...real,
    loadPrincipal: vi.fn(async () => {
      if (s.principalThrows) throw new real.PrincipalUnreadableError("membership", "timeout");
      return s.principal;
    }),
    readableControlledDocIds: vi.fn(async (p: { uid: string }, ids: string[]) => {
      s.readableCalls.push({ uid: p.uid, ids });
      if (s.readable === "throw") throw new real.DcLandscapeUnreadableError("folders", "timeout");
      return new Set([...s.readable].filter((d) => ids.includes(d)));
    }),
  };
});

import { GET } from "@/app/api/transmittal/register/route";
import {
  redactTransmittalForViewer, renderTransmittalSheet, rowToTransmittal, portalLinkState, openTransmittalSheet,
  listTransmittals, transmittalForViewer, RESTRICTED_DOCUMENT_LABEL, type Transmittal,
} from "@/lib/transmittals";

const ORG = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "33333333-3333-4333-8333-333333333333";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";   // the restricted P&ID
const OPEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";  // an open drawing

const issuedRow = (over: Row = {}): Row => ({
  id: T1, org_id: ORG, seq: 7, number: "TR-0007", status: "issued", purpose: "For Construction",
  subject: "Unit 3 HF alkylation relief package", notes: "PID-4412 Rev C supersedes Rev B",
  recipient_name: "Jane Doe", recipient_company: "BuildCo", recipient_email: "jane@buildco.com",
  created_by: "u-sender", created_by_name: "dc@plant", issued_at: "2026-10-01T00:00:00Z",
  acknowledged_meta: null, portal_token: "tok-secret-0007", portal_expires_at: "2099-01-01T00:00:00Z",
  portal_open_count: 2, portal_download_count: 1,
  items: [
    { documentId: PID, number: "PID-4412", title: "Unit 3 HF alkylation relief system", rev: "C", versionId: "v-pid", fileHash: "abc123def456aa", fileSize: 2048, statusAsSent: "Issued", effectiveDate: "2026-10-01" },
    { documentId: OPEN, number: "P-101", title: "Feed pump layout", rev: "B", versionId: "v-open" },
  ],
  ...over,
});
const tr = (over: Row = {}): Transmittal => rowToTransmittal(issuedRow(over));

describe("DIST-17 ruling 1 — who sees which items (redactTransmittalForViewer, pure)", () => {
  it("a member who may NOT read one item: that item reads 'Restricted document' (no number, title, revision, version, hash, size, status, date), the other is intact, and the subject, notes and receipt note are withheld; existence, number, purpose, recipient, dates, count and portal usage stay", () => {
    const v = redactTransmittalForViewer(tr({ acknowledged_meta: { note: "Got PID-4412" } }), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    expect(v.items).toHaveLength(2);
    expect(v.items[0]).toEqual({ documentId: PID, number: RESTRICTED_DOCUMENT_LABEL, title: null, rev: null, versionId: null, restricted: true });
    expect(v.items[1]).toMatchObject({ documentId: OPEN, number: "P-101", title: "Feed pump layout", rev: "B" });
    expect(v.subject).toBeNull();
    expect(v.notes).toBeNull();
    expect(v.acknowledgedMeta?.note).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/PID-4412|HF alkylation|abc123/);
    expect(v).toMatchObject({ number: "TR-0007", status: "issued", purpose: "For Construction", recipientName: "Jane Doe", recipientCompany: "BuildCo", issuedAt: "2026-10-01T00:00:00Z", portalOpenCount: 2, portalDownloadCount: 1 });
    expect(v.viewer).toEqual({ restrictedItems: 1, portalWithheld: true, portalWithheldReason: "restricted", accessUnchecked: false });
  });

  it("REGRESSION: a member who may read EVERY item reads the transmittal exactly as stored — token included", () => {
    const full = tr();
    const v = redactTransmittalForViewer(full, { uid: "u-viewer", isController: false }, new Set([PID, OPEN]));
    expect({ ...v, viewer: undefined }).toEqual({ ...full, viewer: undefined });
    expect(v.portalToken).toBe("tok-secret-0007");
    expect(v.viewer).toEqual({ restrictedItems: 0, portalWithheld: false, portalWithheldReason: null, accessUnchecked: false });
  });

  it("REGRESSION: a controller (DEC-43) and the sender keep every item; the controller keeps the token; the sender keeps it only while they may read every item (ruling 2)", () => {
    const full = tr();
    const ctl = redactTransmittalForViewer(full, { uid: "u-dc", isController: true }, null);
    expect({ ...ctl, viewer: undefined }).toEqual({ ...full, viewer: undefined });
    expect(ctl.viewer?.accessUnchecked).toBe(false);
    const sender = redactTransmittalForViewer(full, { uid: "u-sender", isController: false }, new Set([PID, OPEN]));
    expect({ ...sender, viewer: undefined }).toEqual({ ...full, viewer: undefined });
    const senderLostOne = redactTransmittalForViewer(full, { uid: "u-sender", isController: false }, new Set([OPEN]));
    expect(senderLostOne.items).toEqual(full.items);
    expect(senderLostOne.subject).toBe(full.subject);
    expect(senderLostOne.portalToken).toBeNull();
    expect(senderLostOne.viewer).toMatchObject({ restrictedItems: 0, portalWithheld: true, portalWithheldReason: "restricted" });
  });

  it("an undecidable read (null) fails closed: nobody but the sender and controllers sees an item, nobody but a controller is handed the token, and the row says why", () => {
    const v = redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, null);
    expect(v.items.every((i) => i.restricted)).toBe(true);
    expect(v.viewer).toEqual({ restrictedItems: 2, portalWithheld: true, portalWithheldReason: "unchecked", accessUnchecked: true });
    const sender = redactTransmittalForViewer(tr(), { uid: "u-sender", isController: false }, null);
    expect(sender.items.some((i) => i.restricted)).toBe(false);
    expect(sender.portalToken).toBeNull();
    expect(sender.viewer?.portalWithheldReason).toBe("unchecked");
  });

  it("an item with no document id is restricted for everyone but the sender and controllers; a row with no token withholds nothing; an empty transmittal is shown whole", () => {
    const noId = redactTransmittalForViewer(tr({ items: [{ documentId: "", number: "X-1" }] }), { uid: "u-viewer", isController: false }, new Set([PID]));
    expect(noId.items[0].restricted).toBe(true);
    const noTok = redactTransmittalForViewer(tr({ portal_token: null }), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    expect(noTok.viewer?.portalWithheld).toBe(false);
    const empty = redactTransmittalForViewer(tr({ items: [] }), { uid: "u-viewer", isController: false }, new Set());
    expect(empty.viewer).toMatchObject({ restrictedItems: 0, portalWithheld: false });
    expect(empty.subject).toBe("Unit 3 HF alkylation relief package");
  });

  it("a withheld token keeps its lifecycle on the register: live / revoked / expired / voided are drawn as for anyone", () => {
    const viewer = { uid: "u-viewer", isController: false };
    const live = redactTransmittalForViewer(tr(), viewer, new Set([OPEN]));
    expect(live.portalToken).toBeNull();
    expect(portalLinkState(live)).toBe("live");
    expect(portalLinkState(redactTransmittalForViewer(tr({ portal_revoked_at: "2026-10-02" }), viewer, new Set([OPEN])))).toBe("revoked");
    expect(portalLinkState(redactTransmittalForViewer(tr({ portal_expires_at: "2026-01-01T00:00:00Z" }), viewer, new Set([OPEN])))).toBe("expired");
    expect(portalLinkState(redactTransmittalForViewer(tr({ status: "voided" }), viewer, new Set([OPEN])))).toBe("voided");
    // a row read any other way is judged on its token, as before
    expect(portalLinkState({ ...tr(), portalToken: null })).toBe("none");
  });
});

describe("DIST-17 rulings 1 and 2 — the cover sheet", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("a restricted viewer's sheet prints 'Restricted document' — never the number, title, revision or hash — says how many are restricted, and prints no portal link but says why", () => {
    const v = redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    const html = renderTransmittalSheet(v);
    expect(html).not.toMatch(/PID-4412|HF alkylation|abc123def456|Rev C/);
    expect(html).toContain(RESTRICTED_DOCUMENT_LABEL);
    expect(html).toContain("P-101");
    expect(html).toMatch(/1 of 2 documents on this transmittal is restricted for you/);
    expect(html).toMatch(/The recipient portal link is not shown: you may not read every document on this transmittal/);
    expect(html).not.toContain("tok-secret-0007");
    expect(html).not.toMatch(/Recipient portal — download/);
  });

  it("openTransmittalSheet: the register's withheld row opens with no link and no QR, even with a configured origin; the full row (REGRESSION) prints link and QR as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mfg.yourplant.com");
    const written: string[] = [];
    vi.stubGlobal("window", { location: { origin: "https://mfg.yourplant.com", hostname: "mfg.yourplant.com" }, open: () => ({ document: { open: () => undefined, write: (h: string) => { written.push(h); }, close: () => undefined } }) });
    await openTransmittalSheet(redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, new Set([OPEN])));
    expect(written[0]).not.toContain("/transmittal/");
    expect(written[0]).not.toMatch(/data:image\/png;base64/);
    expect(written[0]).toMatch(/portal link is not shown/);
    written.length = 0;
    await openTransmittalSheet(redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, new Set([PID, OPEN])));
    expect(written[0]).toContain("https://mfg.yourplant.com/transmittal/tok-secret-0007");
    expect(written[0]).toMatch(/data:image\/png;base64/);
    expect(written[0]).toContain("PID-4412");
  });

  it("REGRESSION: a sheet with nothing restricted prints exactly as before (no notice)", () => {
    const html = renderTransmittalSheet(tr());
    expect(html).toContain("PID-4412");
    expect(html).toContain("Unit 3 HF alkylation relief system");
    expect(html).not.toMatch(/restricted for you|portal link is not shown/);
  });
});

const req = (qs: string, auth = true) => new NextRequest(`https://app/api/transmittal/register?${qs}`, auth ? { headers: { authorization: "Bearer jwt" } } : {});
const principalOf = (over: Row = {}) => ({ uid: "u-viewer", orgId: ORG, role: "Viewer", roles: ["Viewer"], isController: false, teamIds: [], ...over });

describe("DIST-17 — /api/transmittal/register serves the register filtered for the viewer", () => {
  beforeEach(() => {
    s.user = { id: "u-viewer" };
    s.principal = principalOf();
    s.principalThrows = false;
    s.readable = new Set([OPEN]);
    s.readableCalls = [];
    s.rows = [issuedRow(), issuedRow({ id: T2, seq: 6, number: "TR-0006", created_by: "u-viewer", items: [{ documentId: PID, number: "PID-4412", rev: "B" }] })];
    s.readError = null;
    s.ops = [];
  });

  it("refuses without a session (401), with a malformed org (400), to a non-member (403); an unreadable membership answers 503 'try again', never 'not a member'", async () => {
    expect((await GET(req(`orgId=${ORG}`, false))).status).toBe(401);
    s.user = null;
    expect((await GET(req(`orgId=${ORG}`))).status).toBe(401);
    s.user = { id: "u-viewer" };
    expect((await GET(req("orgId=nope"))).status).toBe(400);
    s.principal = null;
    const non = await GET(req(`orgId=${ORG}`));
    expect(non.status).toBe(403);
    s.principalThrows = true;
    const down = await GET(req(`orgId=${ORG}`));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ unreadable: true });
  });

  it("a Viewer outside the P&ID's ACL: the item restricted, the token withheld; on their OWN transmittal (sender) the item shown — one read decision for every item, asked through the I-12 predicate", async () => {
    const res = await GET(req(`orgId=${ORG}`));
    expect(res.status).toBe(200);
    const { transmittals } = (await res.json()) as { transmittals: Transmittal[] };
    expect(transmittals.map((t) => t.number)).toEqual(["TR-0007", "TR-0006"]);
    const [other, own] = transmittals;
    expect(other.items[0]).toMatchObject({ number: RESTRICTED_DOCUMENT_LABEL, restricted: true });
    expect(other.items[1]).toMatchObject({ number: "P-101" });
    expect(other.portalToken).toBeNull();
    expect(other.viewer).toMatchObject({ restrictedItems: 1, portalWithheld: true, portalWithheldReason: "restricted" });
    expect(JSON.stringify(other)).not.toMatch(/PID-4412|tok-secret/);
    expect(own.items[0]).toMatchObject({ number: "PID-4412", rev: "B" });
    expect(s.readableCalls).toEqual([{ uid: "u-viewer", ids: [PID, OPEN] }]);
  });

  it("REGRESSION: the same rows as the browser read — the org's transmittals, select *, newest first, 1,000 at most; `id` asks for one", async () => {
    await GET(req(`orgId=${ORG}`));
    expect(s.ops).toEqual(expect.arrayContaining([["from", ["transmittals"]], ["select", ["*"]], ["eq", ["org_id", ORG]], ["order", ["seq", { ascending: false }]], ["limit", [1000]]]));
    s.ops = [];
    const one = (await (await GET(req(`orgId=${ORG}&id=${T2}`))).json()) as { transmittals: Transmittal[] };
    expect(s.ops).toContainEqual(["eq", ["id", T2]]);
    expect(one.transmittals.map((t) => t.id)).toEqual([T2]);
  });

  it("REGRESSION: a controller gets every row whole, tokens included, and no landscape read is made", async () => {
    s.principal = principalOf({ uid: "u-dc", role: "DocCtrl", roles: ["DocCtrl"], isController: true });
    s.user = { id: "u-dc" };
    const { transmittals } = (await (await GET(req(`orgId=${ORG}`))).json()) as { transmittals: Transmittal[] };
    expect(transmittals[0].items.map((i) => i.number)).toEqual(["PID-4412", "P-101"]);
    expect(transmittals[0].portalToken).toBe("tok-secret-0007");
    expect(s.readableCalls).toEqual([]);
  });

  it("a landscape that cannot be read fails closed: items withheld from all but the sender, no token, each row says so", async () => {
    s.readable = "throw";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { transmittals } = (await (await GET(req(`orgId=${ORG}`))).json()) as { transmittals: Transmittal[] };
    warn.mockRestore();
    expect(transmittals[0].items.every((i) => i.restricted)).toBe(true);
    expect(transmittals[0].viewer).toMatchObject({ accessUnchecked: true, portalWithheldReason: "unchecked" });
    expect(transmittals[1].items[0].number).toBe("PID-4412"); // the viewer's own
  });

  it("a database without the table answers the migration hint (404, missingTable); another read error is a 500 sentence", async () => {
    s.readError = { code: "42P01", message: 'relation "transmittals" does not exist' };
    const miss = await GET(req(`orgId=${ORG}`));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ missingTable: true });
    s.readError = { code: "57014", message: "statement timeout" };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await GET(req(`orgId=${ORG}`))).status).toBe(500);
    err.mockRestore();
  });
});

describe("DIST-17 — the data layer reads the register through the server", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("listTransmittals asks /api/transmittal/register with the session's bearer — never a browser SELECT of the rows", async () => {
    const row = redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ transmittals: [row] }), { status: 200 }));
    const rows = await listTransmittals(ORG);
    expect(rows).toEqual([row]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`/api/transmittal/register?orgId=${ORG}`);
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer jwt-test" });
  });

  it("a missing table reads as the migration hint; a refusal throws its sentence", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "x", missingTable: true }), { status: 404 }));
    await expect(listTransmittals(ORG)).rejects.toThrow(/run supabase\/migrations\/20260717_transmittals\.sql/);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Not a member of this workspace." }), { status: 403 }));
    await expect(listTransmittals(ORG)).rejects.toThrow("Not a member of this workspace.");
  });

  it("transmittalForViewer: the server's row for the sheet printed after an issue; a register that cannot be asked withholds the token ('unchecked'), never the browser's row", async () => {
    const decided = redactTransmittalForViewer(tr(), { uid: "u-viewer", isController: false }, new Set([OPEN]));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ transmittals: [decided] }), { status: 200 }));
    expect(await transmittalForViewer(tr())).toEqual(decided);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/transmittal/register?orgId=${ORG}&id=${T1}`);
    fetchMock.mockRejectedValue(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallback = await transmittalForViewer(tr());
    warn.mockRestore();
    expect(fallback.portalToken).toBeNull();
    expect(fallback.viewer).toMatchObject({ portalWithheld: true, portalWithheldReason: "unchecked" });
    expect(renderTransmittalSheet(fallback)).toMatch(/could not be checked just now/);
  });
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => { throw new Error("the register must not be read with the browser client"); },
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt-test" } } }) },
  },
}));
