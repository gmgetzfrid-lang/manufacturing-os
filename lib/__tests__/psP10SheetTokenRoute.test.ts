// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — POST /api/print-sheet-tokens
// (PHYS-19 done-when 3; intelligence DACL-8 residual (c); rulings under
// DEC-90).
//
//   link: the server checks the cover (same workspace, the caller printed
//         it, its printed sheets are exactly this print's at the minted
//         versions, recorded after the mint, linked to no other print) and
//         writes cover_print_id on every UNSETTLED token row of the print in
//         ONE guarded update (fourth review fix: it was chunked, so a failed
//         chunk left a part-linked print) — before the download (the pack
//         path awaits it); a mismatch is the marked refusal (400, refused:
//         true, code cover_mismatch — the only answer that stops the print)
//         and NOTHING is written; a repeat is idempotent; before 20261240
//         (42703 / PGRST204) { available: false }; any other failure 503.
//   settle: PS-P9's, unchanged — it never reads or writes the link (review
//         fix: the link first rode on the fire-and-forget settle).
//   void: a controller (Admin / DocCtrl by the role collection) recalls a
//         print — by a cover, the token print(s) linked to it and then EVERY
//         token of those prints (fourth review fix: a part-linked print is
//         recalled whole) — audit row FIRST (DISTRIBUTION_RECALL with the reason), then
//         every live token voided 'recalled' (a settled one keeps its settle,
//         an unsettled one is settled by it); a non-controller is 403 before
//         anything is read; before 20261240 nothing is written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printSnapshotSheets, mergeLeftOut } from "@/lib/workPackages";
import type { PackSheetRef, PackSkip } from "@/lib/docPack";

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const D1 = "d1d1d1d1-0000-0000-0000-000000000001";
const D2 = "d2d2d2d2-0000-0000-0000-000000000002";
const V1 = "e1e1e1e1-0000-0000-0000-000000000001";
const V2 = "e2e2e2e2-0000-0000-0000-000000000002";
const PRINT = "f0f0f0f0-0000-0000-0000-000000000000";
const COVER = "c1c1c1c1-0000-0000-0000-000000000001";
const PKG = "9a9a9a9a-0000-0000-0000-000000000001";
const UID = "c0c0c0c0-0000-0000-0000-000000000000";
const OTHER_UID = "c9c9c9c9-0000-0000-0000-000000000009";
const MINTED = "2026-10-20T08:00:00.000Z";

type Filters = Array<[string, string, unknown]>;
const state = vi.hoisted(() => ({
  actor: { role: "Viewer", roles: ["Viewer"] as string[] },
  tokenRows: [] as Array<Record<string, unknown>>,
  tokenReadError: null as null | { code?: string; message: string },
  /** the cover-link probe (print_sheet_tokens .neq(print_id)) */
  probeRows: [] as unknown[],
  probeError: null as null | { code?: string; message: string },
  cover: null as null | Record<string, unknown>,
  coverError: null as null | { message: string },
  auditError: null as null | { message: string },
  updateShort: false,
  /** review fix 3: what a concurrent request (the same link, the client's
   *  timed-out first attempt) wrote while this one was checking — applied to
   *  the token rows when a short update lands */
  concurrentLink: null as null | string,
  rereadError: null as null | { message: string },
  updateError: null as null | { message: string },
  /** fourth review fix: reads honour `eq cover_print_id` and `in print_id`
   *  (off by default — most fixtures carry no link column) */
  filterReads: false,
  log: [] as string[],
  inserts: [] as Array<{ table: string; rows: Record<string, unknown> }>,
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Filters }>,
  reads: [] as Array<{ table: string; cols: string; filters: Filters }>,
  /** token ids an update already named in this request */
  touched: new Set<string>(),
}));

function chain(table: string) {
  const filters: Filters = [];
  let op: "select" | "insert" | "update" = "select";
  let patch: Record<string, unknown> = {};
  let cols = "";
  let neq = false;
  const c: Record<string, unknown> = {};
  const settle = () => {
    if (op === "insert") {
      state.log.push(`insert:${table}`);
      return { data: null, error: table === "audit_logs" ? state.auditError : null };
    }
    if (op === "update") {
      state.log.push("update");
      state.updates.push({ patch, filters: [...filters] });
      if (state.updateError) return { data: null, error: state.updateError };
      const ids = filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[] | undefined;
      for (const id of ids ?? []) state.touched.add(id);
      const coverNull = filters.some((f) => f[0] === "is" && f[1] === "cover_print_id" && f[2] === null);
      const n = ids ? ids.length : state.tokenRows.filter((r) => !r.settled_at && !state.touched.has(String(r.id)) && (!coverNull || !r.cover_print_id)).length;
      if (state.updateShort && state.concurrentLink) {
        for (const r of state.tokenRows) r.cover_print_id = state.concurrentLink;
      }
      return { data: Array.from({ length: state.updateShort ? Math.max(0, n - 1) : n }, (_, i) => ({ id: `r${i}` })), error: null };
    }
    state.reads.push({ table, cols, filters: [...filters] });
    if (table === "print_sheet_tokens" && neq) {
      state.log.push("probe");
      return state.probeError ? { data: null, error: state.probeError } : { data: state.probeRows, error: null };
    }
    if (table === "print_sheet_tokens" && cols === "id, cover_print_id" && state.rereadError) {
      return { data: null, error: state.rereadError };
    }
    if (table === "print_sheet_tokens") {
      if (state.tokenReadError) return { data: null, error: state.tokenReadError };
      let rows = state.tokenRows;
      if (state.filterReads) {
        for (const [op2, col, val] of filters) {
          if (op2 === "eq" && col === "cover_print_id") rows = rows.filter((r) => r.cover_print_id === val);
          if (op2 === "eq" && col === "print_id") rows = rows.filter((r) => r.print_id === val);
          if (op2 === "in" && col === "print_id") rows = rows.filter((r) => (val as unknown[]).includes(r.print_id));
        }
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void) => resolve(settle());
      return (...args: unknown[]) => {
        if (p === "select" && op === "select") cols = String(args[0]);
        if (p === "insert") { op = "insert"; state.inserts.push({ table, rows: args[0] as Record<string, unknown> }); }
        if (p === "update") { op = "update"; patch = args[0] as Record<string, unknown>; }
        if (p === "neq") neq = true;
        if (p === "eq" || p === "in" || p === "is" || p === "neq") filters.push([p, String(args[0]), args[1]]);
        if (p === "maybeSingle") {
          state.reads.push({ table, cols, filters: [...filters] });
          if (table === "work_package_prints") return Promise.resolve(state.coverError ? { data: null, error: state.coverError } : { data: state.cover, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

// lib/workPackages (printSnapshotSheets, mergeLeftOut — the snapshot the
// packages page records) is imported for the contract test below; its
// browser client and side-effect modules are stood in for.
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}) }));

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: async (_req: Request, orgId: string) => ({
    userId: UID, email: "u@x", orgId, role: state.actor.role, roles: state.actor.roles, admin: { from: (t: string) => chain(t) },
  }),
  callerScopedClient: () => ({ from: (t: string) => chain(t) }),
}));

const coverOf = (over: Record<string, unknown> = {}) => ({
  id: COVER, org_id: ORG, package_id: PKG, printed_by: UID, printed_at: "2026-10-20T08:00:05.000Z",
  sheets: [
    { documentId: D1, versionId: V1, printed: true },
    { documentId: D2, versionId: V2, printed: true },
    { documentId: "d3d3d3d3-0000-0000-0000-000000000003", versionId: null, printed: false, leftOutCode: "build_failed" },
  ],
  ...over,
});

beforeEach(() => {
  state.actor = { role: "Viewer", roles: ["Viewer"] };
  state.tokenRows = [
    { id: "t1", document_id: D1, version_id: V1, minted_at: MINTED, print_id: PRINT, settled_at: null, voided_at: null },
    { id: "t2", document_id: D2, version_id: V2, minted_at: MINTED, print_id: PRINT, settled_at: null, voided_at: null },
  ];
  state.tokenReadError = null;
  state.probeRows = [];
  state.probeError = null;
  state.cover = coverOf();
  state.coverError = null;
  state.auditError = null;
  state.updateShort = false;
  state.concurrentLink = null;
  state.rereadError = null;
  state.updateError = null;
  state.filterReads = false;
  state.log = [];
  state.inserts = [];
  state.updates = [];
  state.reads = [];
  state.touched = new Set();
});

async function post(body: unknown) {
  const { POST } = await import("@/app/api/print-sheet-tokens/route");
  return POST(new NextRequest("https://app/api/print-sheet-tokens", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer x" } }));
}
const settleBody = (extra: Record<string, unknown> = {}) => ({ action: "settle", orgId: ORG, printId: PRINT, printed: [D1, D2], ...extra });
const linkBody = (extra: Record<string, unknown> = {}) => ({ action: "link", orgId: ORG, printId: PRINT, coverPrintId: COVER, printed: [D1, D2], ...extra });

describe("PS-P10 link — a work-package pack's sheet tokens link by key to its cover's print, before the download", () => {
  it("a matching cover: every unsettled token row of the print is linked (cover_print_id only — nothing settled); checked before anything is written", async () => {
    const res = await post(linkBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, sheets: 2 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch).toEqual({ cover_print_id: COVER });
    // ONE guarded statement over the print (fourth review fix) — never by id
    expect(state.updates[0].filters).toEqual([
      ["eq", "print_id", PRINT], ["eq", "org_id", ORG], ["eq", "minted_by", UID], ["is", "settled_at", null], ["is", "cover_print_id", null],
    ]);
    expect(state.log).toEqual(["probe", "update"]);
    const tokenRead = state.reads.find((r) => r.table === "print_sheet_tokens" && !r.filters.some((f) => f[0] === "neq"))!;
    expect(tokenRead.filters).toEqual(expect.arrayContaining([
      ["eq", "print_id", PRINT], ["eq", "org_id", ORG], ["eq", "minted_by", UID], ["is", "settled_at", null],
    ]));
    const coverRead = state.reads.find((r) => r.table === "work_package_prints")!;
    expect(coverRead.filters).toContainEqual(["eq", "id", COVER]);
    const probe = state.reads.find((r) => r.filters.some((f) => f[0] === "neq"))!;
    expect(probe.filters).toEqual(expect.arrayContaining([["eq", "cover_print_id", COVER], ["neq", "print_id", PRINT]]));
  });

  it("a sheet left out of the PDF (on the cover as printed:false) is not among `printed`; its token is linked too — the settle later voids it", async () => {
    state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1, printed: true }, { documentId: D2, versionId: V2, printed: false, leftOutCode: "fetch_failed" }] });
    expect(await (await post(linkBody({ printed: [D1] }))).json()).toEqual({ linked: true, sheets: 2 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters).toContainEqual(["eq", "print_id", PRINT]);
  });

  it("a cover snapshot from before VFY-19 (no `printed` key) counts every entry as printed", async () => {
    state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] });
    expect(await (await post(linkBody())).json()).toEqual({ linked: true, sheets: 2 });
  });

  it("a repeat of a link already written answers linked and writes nothing (a retry after a lost answer)", async () => {
    state.tokenRows = state.tokenRows.map((r) => ({ ...r, cover_print_id: COVER }));
    expect(await (await post(linkBody())).json()).toEqual({ linked: true, sheets: 2 });
    expect(state.updates).toEqual([]);
    expect(state.log).toEqual([]);
  });

  const refusals: Array<[string, () => void]> = [
    ["a cover of another workspace", () => { state.cover = coverOf({ org_id: OTHER_ORG }); }],
    ["a cover someone else printed", () => { state.cover = coverOf({ printed_by: OTHER_UID }); }],
    ["a cover with no recorded printer", () => { state.cover = coverOf({ printed_by: null }); }],
    ["an unknown cover", () => { state.cover = null; }],
    ["a cover listing other sheets", () => { state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1, printed: true }] }); }],
    ["a cover listing another version of a sheet", () => { state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1, printed: true }, { documentId: D2, versionId: V1, printed: true }] }); }],
    ["a cover recorded before the tokens were minted", () => { state.cover = coverOf({ printed_at: "2026-10-20T07:59:00.000Z" }); }],
    ["a cover already linked to another print", () => { state.probeRows = [{ id: "x" }]; }],
    ["a print already linked to another cover", () => { state.tokenRows = state.tokenRows.map((r, i) => (i === 0 ? { ...r, cover_print_id: "c2c2c2c2-0000-0000-0000-000000000002" } : r)); }],
  ];
  for (const [what, arrange] of refusals) {
    it(`refuses ${what} with the marked 400 (refused, cover_mismatch) and writes NOTHING (the pack path then stops the print)`, async () => {
      arrange();
      const res = await post(linkBody());
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ refused: true, code: "cover_mismatch", error: expect.any(String) });
      expect(state.updates).toEqual([]);
      expect(state.inserts).toEqual([]);
    });
  }

  it("a malformed request is 400 before anything is read", async () => {
    for (const body of [linkBody({ coverPrintId: "nope" }), linkBody({ coverPrintId: 7 }), linkBody({ coverPrintId: undefined }), linkBody({ printId: "x" }), linkBody({ printed: [] }), linkBody({ printed: "x" })]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      // not the refusal: the pack path prints unlinked on it (fourth review fix)
      const said = (await res.json()) as Record<string, unknown>;
      expect(said.refused).toBeUndefined();
      expect(said.code).toBeUndefined();
    }
    expect(state.reads).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("an unknown or already settled print is 404 (a settled sheet is never linked after the fact)", async () => {
    state.tokenRows = [];
    expect((await post(linkBody())).status).toBe(404);
    expect(state.updates).toEqual([]);
  });

  it("BEFORE 20261240 (42703 / PGRST204 on the read, the probe or the write) — or before 20261237: { available: false, linked: false }, nothing written", async () => {
    for (const tokenReadError of [
      { code: "42703", message: "column print_sheet_tokens.cover_print_id does not exist" },
      { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" },
    ]) {
      state.tokenReadError = tokenReadError;
      const res = await post(linkBody());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, linked: false });
    }
    state.tokenReadError = null;
    state.probeError = { code: "PGRST204", message: "Could not find the 'cover_print_id' column of 'print_sheet_tokens' in the schema cache" };
    expect(await (await post(linkBody())).json()).toEqual({ available: false, linked: false });
    expect(state.reads.some((r) => r.table === "work_package_prints")).toBe(false);
    state.probeError = null;
    state.updateError = { code: "PGRST204", message: "Could not find the 'cover_print_id' column" } as { message: string };
    expect(await (await post(linkBody())).json()).toEqual({ available: false, linked: false });
  });

  it("any other failure reading the print, the link or the cover — or writing it — is a 503 (the pack path retries once, then prints unlinked — fail open)", async () => {
    state.tokenReadError = { code: "57014", message: "statement timeout" };
    expect((await post(linkBody())).status).toBe(503);
    state.tokenReadError = null;
    state.probeError = { code: "57014", message: "statement timeout" };
    expect((await post(linkBody())).status).toBe(503);
    state.probeError = null;
    state.coverError = { message: "boom" };
    expect((await post(linkBody())).status).toBe(503);
    expect(state.updates).toEqual([]);
    state.coverError = null;
    state.updateError = { message: "print_sheet_tokens: a sheet is linked to its cover's print only before it is settled" };
    expect((await post(linkBody())).status).toBe(503);
  });

  it("an unknown action is a bare 400 — never the marked refusal", async () => {
    const res = await post({ action: "frobnicate", orgId: ORG });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown action" });
  });

  // Fourth review fix: the link was written in chunks of 100 by id, which do
  // not form one transaction — a pack of 101 to 150 sheets whose second chunk
  // failed was left part-linked (and printed, fail open). Now ONE statement.
  it("a pack of 150 sheets is linked by ONE guarded update — whole or not at all", async () => {
    state.tokenRows = Array.from({ length: 150 }, (_, i) => ({
      id: `t${i}`, document_id: `d${String(i).padStart(7, "0")}-0000-0000-0000-000000000000`, version_id: V1, minted_at: MINTED, print_id: PRINT, settled_at: null, voided_at: null,
    }));
    state.cover = coverOf({ sheets: state.tokenRows.map((r) => ({ documentId: r.document_id, versionId: V1, printed: true })) });
    const res = await post(linkBody({ printed: state.tokenRows.map((r) => r.document_id) }));
    expect(await res.json()).toEqual({ linked: true, sheets: 150 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters.some((f) => f[0] === "in")).toBe(false);
    // and a failing write links nothing: one statement, one 503
    state.updates = [];
    state.updateError = { message: "statement timeout" };
    expect((await post(linkBody({ printed: state.tokenRows.map((r) => r.document_id) }))).status).toBe(503);
    expect(state.updates).toHaveLength(1);
  });

  it("the link write is one statement on the route source (no chunk loop in linkCover)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/print-sheet-tokens/route.ts"), "utf8");
    const link = src.slice(src.indexOf("async function linkCover("), src.indexOf("async function checkCoverLink("));
    expect(link).not.toContain("chunks(");
    expect(link.match(/\.update\(\{ cover_print_id: coverPrintId \}\)/g)).toHaveLength(1);
  });

  it("a short link (the print changed under it) is a 409", async () => {
    state.updateShort = true;
    expect((await post(linkBody())).status).toBe(409);
  });

  // Third review fix: the client's retry after its own timeout can race the
  // first request it gave up on. The first writes the link while the retry is
  // checking; the retry's guarded update then lands short. The re-read shows
  // every row linked to THIS cover — the link is written, and the retry says
  // so (a 409 here used to stop a correctly linked print).
  it("a short link whose rows a concurrent request linked to THIS cover answers linked (the lost-answer retry is idempotent)", async () => {
    state.updateShort = true;
    state.concurrentLink = COVER;
    const res = await post(linkBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, sheets: 2 });
    const reread = state.reads.filter((r) => r.table === "print_sheet_tokens" && r.cols === "id, cover_print_id");
    expect(reread).toHaveLength(1);
    expect(reread[0].filters).toEqual([["eq", "print_id", PRINT], ["eq", "org_id", ORG], ["eq", "minted_by", UID]]);
  });

  it("a short link whose rows name ANOTHER cover is still a 409; a re-read that fails is a 503", async () => {
    state.updateShort = true;
    state.concurrentLink = "c2c2c2c2-0000-0000-0000-000000000002";
    expect((await post(linkBody())).status).toBe(409);
    for (const r of state.tokenRows) delete r.cover_print_id;
    state.concurrentLink = null;
    state.rereadError = { message: "statement timeout" };
    expect((await post(linkBody())).status).toBe(503);
  });

  // Second review fix: the cover the route checks is the snapshot the
  // packages page REALLY records — printSnapshotSheets over the included
  // sheets (mapped as the page maps them) plus the merged left-out list —
  // and `printed` is those same included sheets. A rename in
  // PrintSnapshotSheet that coverPrintedSheets no longer reads would refuse
  // every work-package print with codes; this test fails first.
  it("CONTRACT: the snapshot the packages page records (printSnapshotSheets) is accepted as this print's cover", async () => {
    const D3 = "d3d3d3d3-0000-0000-0000-000000000003";
    const V3 = "e3e3e3e3-0000-0000-0000-000000000003";
    const included: PackSheetRef[] = [
      { documentId: D1, versionId: V1, label: "P-101", pageCount: 1 },
      { documentId: D2, versionId: V2, label: "P-102", pageCount: 2, stampMapped: [{ char: "Δ", codePoint: "U+0394", printedAs: "Delta" }] },
    ];
    const builderSkipped: PackSkip[] = [{ documentId: D3, label: "P-103", reason: "could not be read", code: "build_failed", versionId: V3 }];
    const sheets = printSnapshotSheets(
      // exactly the page's mapping (pinned on its source below)
      included.map((s) => ({
        documentId: s.documentId,
        versionId: s.versionId,
        revLabel: "B",
        label: s.label,
        ...(s.stampMapped ? { stampMapped: s.stampMapped } : {}),
      })),
      mergeLeftOut([], builderSkipped).flatMap((s) =>
        s.documentId && s.code ? [{ documentId: s.documentId, label: s.label, code: s.code, reason: s.reason, versionId: s.versionId ?? null }] : []),
    );
    expect(sheets).toHaveLength(3);
    state.cover = coverOf({ sheets: JSON.parse(JSON.stringify(sheets)) });
    state.tokenRows = [
      ...state.tokenRows,
      { id: "t3", document_id: D3, version_id: V3, minted_at: MINTED, print_id: PRINT, settled_at: null, voided_at: null },
    ];
    const res = await post(linkBody({ printed: included.map((s) => s.documentId) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, sheets: 3 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters).toContainEqual(["eq", "print_id", PRINT]);

    // The page maps the included sheets into the snapshot by these keys, and
    // sends the same included sheets as `printed` (lib/docPack.ts).
    const page = readFileSync(join(process.cwd(), "app/(protected)/packages/page.tsx"), "utf8");
    const call = page.slice(page.indexOf("const printId = await recordPackagePrint({"), page.indexOf("await cover.linkPrint(printId);"));
    expect(call).toContain("sheets: includedSheets.map((s) => ({\n              documentId: s.documentId,\n              versionId: s.versionId,");
    const pack = readFileSync(join(process.cwd(), "lib/docPack.ts"), "utf8");
    expect(pack).toContain("printedDocumentIds: includedSheets.map((s) => s.documentId),\n        });");
  });
});

describe("PS-P10 settle — never reads or writes the cover link (review fix)", () => {
  it("REGRESSION: a settle is PS-P9's request and answer — no probe, no cover read, no link written; a stray coverPrintId is ignored", async () => {
    for (const body of [settleBody(), settleBody({ coverPrintId: COVER })]) {
      state.updates = [];
      state.reads = [];
      state.log = [];
      state.touched = new Set();
      const res = await post(body);
      expect(await res.json()).toEqual({ settled: true, voided: 0 });
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].patch).toEqual({ settled_at: expect.any(String) });
      expect(state.reads.map((r) => r.table)).toEqual(["print_sheet_tokens"]);
      expect(state.log).toEqual(["update"]);
    }
  });

  it("a cover-link failure can no longer stop a settle: with the link probe and the cover unreadable, a left-out sheet is still voided 'not_printed' and the rest settle", async () => {
    state.probeError = { code: "57014", message: "statement timeout" };
    state.coverError = { message: "boom" };
    const res = await post(settleBody({ printed: [D1], coverPrintId: COVER }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true, voided: 1 });
    expect(state.updates[0].patch).toEqual({ voided_at: expect.any(String), void_reason: "not_printed", settled_at: expect.any(String) });
    expect(state.updates[0].filters).toContainEqual(["in", "id", ["t2"]]);
    expect(state.updates[1].patch).toEqual({ settled_at: expect.any(String) });
    expect(state.reads.some((r) => r.table === "work_package_prints")).toBe(false);
  });

  it("the settle's token read names neither the link nor the minted version (pinned on the route source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "app/api/print-sheet-tokens/route.ts"), "utf8");
    const settle = src.slice(src.indexOf('if (body.action === "settle")'), src.indexOf('if (body.action === "link")'));
    expect(settle).toContain('.select("id, document_id")');
    expect(settle).not.toContain("cover_print_id");
    expect(settle).not.toContain("checkCoverLink");
  });
});

describe("PS-P10 void — a controller recalls a printed pack", () => {
  const voidBody = (extra: Record<string, unknown> = {}) => ({ action: "void", orgId: ORG, coverPrintId: COVER, reason: "Issued with the wrong revision of P-101", ...extra });
  const asController = (role = "DocCtrl", roles = ["DocCtrl"]) => { state.actor = { role, roles }; };
  const settled = () => {
    state.tokenRows = state.tokenRows.map((r) => ({ ...r, settled_at: "2026-10-20T08:01:00Z" }));
  };

  it("a non-controller (any member without Admin / DocCtrl) is refused 403 before anything is read or written", async () => {
    for (const actor of [{ role: "Viewer", roles: ["Viewer"] }, { role: "Manager", roles: ["Manager", "Drafter"] }]) {
      state.actor = actor;
      const res = await post(voidBody());
      expect(res.status).toBe(403);
    }
    expect(state.reads).toEqual([]);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("a settled print: the audit row is written FIRST (DISTRIBUTION_RECALL, the reason, the cover and the token print), then every live sheet is voided 'recalled' keeping its settle", async () => {
    asController();
    settled();
    const res = await post(voidBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recalled: true, voided: 2, alreadyVoid: 0 });
    expect(state.log).toEqual(["insert:audit_logs", "update"]);
    const audit = state.inserts[0];
    expect(audit.table).toBe("audit_logs");
    expect(audit.rows).toMatchObject({
      action: "DISTRIBUTION_RECALL", resource_type: "work_package", resource_id: PKG, org_id: ORG, user_id: UID, user_role: "DocCtrl",
      details: { kind: "sheet_print_recall", coverPrintId: COVER, printIds: [PRINT], reason: "Issued with the wrong revision of P-101", sheets: 2, alreadyVoid: 0, recordedBeforeApply: true },
    });
    expect(state.updates[0].patch).toEqual({ voided_at: expect.any(String), void_reason: "recalled" });
    expect(state.updates[0].filters).toEqual(expect.arrayContaining([["in", "id", ["t1", "t2"]], ["is", "voided_at", null]]));
    // the token print was found by the cover's print id, in this workspace,
    // and then every token of that print was read (fourth review fix)
    const tokenReads = state.reads.filter((r) => r.table === "print_sheet_tokens");
    expect(tokenReads).toHaveLength(2);
    expect(tokenReads[0].cols).toBe("print_id");
    expect(tokenReads[0].filters).toEqual([["eq", "org_id", ORG], ["eq", "cover_print_id", COVER]]);
    expect(tokenReads[1].filters).toEqual([["eq", "org_id", ORG], ["in", "print_id", [PRINT]]]);
  });

  it("the controller tier is the role COLLECTION: a Manager headline holding DocCtrl additively may recall; an Admin is recorded as Admin", async () => {
    asController("Manager", ["Manager", "DocCtrl"]);
    settled();
    expect((await post(voidBody())).status).toBe(200);
    expect(state.inserts[0].rows).toMatchObject({ user_role: "DocCtrl" });
    state.inserts = [];
    asController("Admin", ["Admin"]);
    expect((await post(voidBody())).status).toBe(200);
    expect(state.inserts[0].rows).toMatchObject({ user_role: "Admin" });
  });

  it("an unsettled print is settled by the void; a sheet already void is skipped and counted", async () => {
    asController();
    state.tokenRows = [
      { id: "t1", document_id: D1, print_id: PRINT, settled_at: "2026-10-20T08:01:00Z", voided_at: null },
      { id: "t2", document_id: D2, print_id: PRINT, settled_at: null, voided_at: null },
      { id: "t3", document_id: "d3d3d3d3-0000-0000-0000-000000000003", print_id: PRINT, settled_at: "2026-10-20T08:01:00Z", voided_at: "2026-10-20T08:01:00Z" },
    ];
    expect(await (await post(voidBody())).json()).toEqual({ recalled: true, voided: 2, alreadyVoid: 1 });
    expect(state.updates.map((u) => u.patch)).toEqual([
      { voided_at: expect.any(String), void_reason: "recalled" },
      { voided_at: expect.any(String), void_reason: "recalled", settled_at: expect.any(String) },
    ]);
    expect(state.updates[0].filters).toContainEqual(["in", "id", ["t1"]]);
    expect(state.updates[1].filters).toContainEqual(["in", "id", ["t2"]]);
  });

  it("by the token print id (a pack without a cover): the same void, the audit row on the workspace", async () => {
    asController();
    settled();
    const res = await post({ action: "void", orgId: ORG, printId: PRINT, reason: "Wrong pack" });
    expect(await res.json()).toEqual({ recalled: true, voided: 2, alreadyVoid: 0 });
    expect(state.inserts[0].rows).toMatchObject({ resource_type: "org", resource_id: ORG, details: { coverPrintId: null, printIds: [PRINT] } });
    const tokenReads = state.reads.filter((r) => r.table === "print_sheet_tokens");
    expect(tokenReads).toHaveLength(1);
    expect(tokenReads[0].filters).toEqual([["eq", "org_id", ORG], ["in", "print_id", [PRINT]]]);
    expect(state.reads.some((r) => r.table === "work_package_prints")).toBe(false);
  });

  // Fourth review fix: a print linked only in part (rows a link never reached)
  // is still recalled WHOLE by its cover — the cover finds the token print,
  // and the recall takes every token of it; another print's rows are untouched.
  it("a print with some rows linked and some not is recalled whole by its cover", async () => {
    asController();
    state.filterReads = true;
    const OTHER_PRINT = "f9f9f9f9-0000-0000-0000-000000000009";
    state.tokenRows = [
      { id: "t1", document_id: D1, print_id: PRINT, cover_print_id: COVER, settled_at: "2026-10-20T08:01:00Z", voided_at: null },
      { id: "t2", document_id: D2, print_id: PRINT, cover_print_id: null, settled_at: "2026-10-20T08:01:00Z", voided_at: null },
      { id: "t3", document_id: "d3d3d3d3-0000-0000-0000-000000000003", print_id: PRINT, cover_print_id: null, settled_at: null, voided_at: null },
      { id: "t9", document_id: D1, print_id: OTHER_PRINT, cover_print_id: null, settled_at: "2026-10-20T08:01:00Z", voided_at: null },
    ];
    const res = await post(voidBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recalled: true, voided: 3, alreadyVoid: 0 });
    const voidedIds = state.updates.flatMap((u) => (u.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[]) ?? []);
    expect(voidedIds.sort()).toEqual(["t1", "t2", "t3"]);
    expect(state.inserts[0].rows).toMatchObject({ details: { printIds: [PRINT], sheets: 3 } });
  });

  it("a reason is required, and exactly one print id", async () => {
    asController();
    for (const body of [voidBody({ reason: "" }), voidBody({ reason: "  x " }), voidBody({ reason: "y".repeat(501) }), voidBody({ printId: PRINT }), { action: "void", orgId: ORG, reason: "Wrong pack" }, voidBody({ coverPrintId: "nope" })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("an unknown cover, or one in another workspace, is 404 and nothing is written", async () => {
    asController();
    state.cover = null;
    expect((await post(voidBody())).status).toBe(404);
    state.cover = coverOf({ org_id: OTHER_ORG });
    expect((await post(voidBody())).status).toBe(404);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("BEFORE 20261240 (no link column, or no table): { available: false } — no audit row, no void", async () => {
    asController();
    for (const tokenReadError of [
      { code: "42703", message: "column print_sheet_tokens.cover_print_id does not exist" },
      { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" },
    ]) {
      state.tokenReadError = tokenReadError;
      const res = await post(voidBody());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false, recalled: false });
    }
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("a print whose sheets carry no per-print code is 404, and one already wholly void is 409 — neither writes an audit row", async () => {
    asController();
    state.tokenRows = [];
    const none = await post(voidBody());
    expect(none.status).toBe(404);
    const said = ((await none.json()) as { error: string }).error;
    // review fix: said truthfully — no code is LINKED; the paper may still carry live codes
    expect(said).toMatch(/No sheet code is linked to this print record/);
    expect(said).toMatch(/nothing was changed/);
    expect(said).toMatch(/keep scanning by their revision's status/);
    expect(said).not.toMatch(/carries no per-print code|cannot reach its paper/);
    // second review fix: a print stopped by a failed link leaves its record and no paper — said too
    expect(said).toMatch(/stopped before anything was downloaded/);
    expect(said).toMatch(/no paper left — there is nothing to withdraw/);
    // third review fix: a link that failed (fail open) printed the pack unlinked — said too
    expect(said).toMatch(/could not be linked when it was printed \(the link failed, so the pack printed unlinked/);
    state.tokenRows = [{ id: "t1", document_id: D1, print_id: PRINT, settled_at: "x", voided_at: "y" }];
    expect((await post(voidBody())).status).toBe(409);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("an audit row that cannot be written stops the recall: 503, nothing voided", async () => {
    asController();
    settled();
    state.auditError = { message: "insert refused" };
    expect((await post(voidBody())).status).toBe(503);
    expect(state.updates).toEqual([]);
  });

  it("a short or failed void is a 409 naming how many were recalled, and a second audit row says the recall was incomplete — never a silent success", async () => {
    asController();
    settled();
    state.updateShort = true;
    const res = await post(voidBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ voided: 1 });
    expect(state.inserts.map((i) => (i.rows.details as Record<string, unknown>).incomplete ?? false)).toEqual([false, true]);
    state.inserts = [];
    state.updateShort = false;
    state.updateError = { message: "print_sheet_tokens: a settled print stays settled" };
    expect((await post(voidBody())).status).toBe(409);
    expect(state.inserts).toHaveLength(2);
  });
});
