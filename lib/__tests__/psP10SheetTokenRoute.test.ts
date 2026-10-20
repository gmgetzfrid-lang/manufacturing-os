// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — POST /api/print-sheet-tokens
// (PHYS-19 done-when 3; intelligence DACL-8 residual (c); rulings under
// DEC-90).
//
//   settle + coverPrintId: the server checks the cover (same workspace, the
//         caller printed it, its printed sheets are exactly this print's at
//         the minted versions, recorded after the mint, linked to no other
//         print) and writes cover_print_id on every token row of the print;
//         a mismatch is 400 and NOTHING is written; before 20261240 (42703 /
//         PGRST204 on the probe) the id is ignored and the print settles as
//         today. A settle without a cover is byte-for-byte today's.
//   void: a controller (Admin / DocCtrl by the role collection) recalls a
//         print — audit row FIRST (DISTRIBUTION_RECALL with the reason), then
//         every live token voided 'recalled' (a settled one keeps its settle,
//         an unsettled one is settled by it); a non-controller is 403 before
//         anything is read; before 20261240 nothing is written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
  updateError: null as null | { message: string },
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
      const n = ids ? ids.length : state.tokenRows.filter((r) => !r.settled_at && !state.touched.has(String(r.id))).length;
      return { data: Array.from({ length: state.updateShort ? Math.max(0, n - 1) : n }, (_, i) => ({ id: `r${i}` })), error: null };
    }
    state.reads.push({ table, cols, filters: [...filters] });
    if (table === "print_sheet_tokens" && neq) {
      state.log.push("probe");
      return state.probeError ? { data: null, error: state.probeError } : { data: state.probeRows, error: null };
    }
    if (table === "print_sheet_tokens") {
      return state.tokenReadError ? { data: null, error: state.tokenReadError } : { data: state.tokenRows, error: null };
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
  state.updateError = null;
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

describe("PS-P10 settle — a work-package pack's sheet tokens link by key to its cover's print", () => {
  it("a matching cover: every token row of the print is settled WITH cover_print_id; the answer says it is linked", async () => {
    const res = await post(settleBody({ coverPrintId: COVER }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true, voided: 0, coverLinked: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch).toEqual({ settled_at: expect.any(String), cover_print_id: COVER });
    // checked before anything was written
    expect(state.log).toEqual(["probe", "update"]);
    const coverRead = state.reads.find((r) => r.table === "work_package_prints")!;
    expect(coverRead.filters).toContainEqual(["eq", "id", COVER]);
    const probe = state.reads.find((r) => r.filters.some((f) => f[0] === "neq"))!;
    expect(probe.filters).toEqual(expect.arrayContaining([["eq", "cover_print_id", COVER], ["neq", "print_id", PRINT]]));
  });

  it("a sheet left out of the PDF is voided 'not_printed' and linked too; the printed ones settle linked", async () => {
    state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1, printed: true }, { documentId: D2, versionId: V2, printed: false, leftOutCode: "fetch_failed" }] });
    const res = await post(settleBody({ printed: [D1], coverPrintId: COVER }));
    expect(await res.json()).toEqual({ settled: true, voided: 1, coverLinked: true });
    expect(state.updates[0].patch).toMatchObject({ void_reason: "not_printed", cover_print_id: COVER });
    expect(state.updates[1].patch).toEqual({ settled_at: expect.any(String), cover_print_id: COVER });
  });

  it("a cover snapshot from before VFY-19 (no `printed` key) counts every entry as printed", async () => {
    state.cover = coverOf({ sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] });
    expect(await (await post(settleBody({ coverPrintId: COVER }))).json()).toEqual({ settled: true, voided: 0, coverLinked: true });
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
  ];
  for (const [what, arrange] of refusals) {
    it(`refuses ${what} with 400 and writes NOTHING (the tokens stay live, as an unsettled print's always do)`, async () => {
      arrange();
      const res = await post(settleBody({ coverPrintId: COVER }));
      expect(res.status).toBe(400);
      expect(state.updates).toEqual([]);
      expect(state.inserts).toEqual([]);
    });
  }

  it("a malformed cover id is 400 before anything is read", async () => {
    expect((await post(settleBody({ coverPrintId: "nope" }))).status).toBe(400);
    expect((await post(settleBody({ coverPrintId: 7 }))).status).toBe(400);
    expect(state.reads).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("BEFORE 20261240 (42703 / PGRST204 on the probe) the cover id is ignored and the print settles exactly as today", async () => {
    for (const probeError of [
      { code: "42703", message: 'column print_sheet_tokens.cover_print_id does not exist' },
      { code: "PGRST204", message: "Could not find the 'cover_print_id' column of 'print_sheet_tokens' in the schema cache" },
    ]) {
      state.updates = [];
      state.probeError = probeError;
      const res = await post(settleBody({ coverPrintId: COVER }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settled: true, voided: 0, coverLinked: false });
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].patch).toEqual({ settled_at: expect.any(String) });
    }
    // the cover was never read: nothing to link it to yet
    expect(state.reads.some((r) => r.table === "work_package_prints")).toBe(false);
  });

  it("any other failure reading the link or the cover is a 503 and nothing is settled", async () => {
    state.probeError = { code: "57014", message: "statement timeout" };
    expect((await post(settleBody({ coverPrintId: COVER }))).status).toBe(503);
    state.probeError = null;
    state.coverError = { message: "boom" };
    expect((await post(settleBody({ coverPrintId: COVER }))).status).toBe(503);
    expect(state.updates).toEqual([]);
  });

  it("REGRESSION: a settle without a cover (the asset hub's pack, the two Print all packs) is today's request and today's answer — no cover read, no link written", async () => {
    const res = await post(settleBody());
    expect(await res.json()).toEqual({ settled: true, voided: 0 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch).toEqual({ settled_at: expect.any(String) });
    expect(state.reads.map((r) => r.table)).toEqual(["print_sheet_tokens"]);
    expect(state.log).toEqual(["update"]);
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
    // the tokens were found by the cover's print id, in this workspace
    const tokenRead = state.reads.find((r) => r.table === "print_sheet_tokens")!;
    expect(tokenRead.filters).toEqual(expect.arrayContaining([["eq", "org_id", ORG], ["eq", "cover_print_id", COVER]]));
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
    expect(state.reads.find((r) => r.table === "print_sheet_tokens")!.filters).toContainEqual(["eq", "print_id", PRINT]);
    expect(state.reads.some((r) => r.table === "work_package_prints")).toBe(false);
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
    expect(((await none.json()) as { error: string }).error).toMatch(/cannot reach its paper/);
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
