// public-surfaces PS-P9 — POST /api/print-sheet-tokens, the per-print sheet
// token's only writer (print_sheet_tokens is service-role only, 20261237).
//
//   mint: a signed-in active member only (authorizeOrgRole over every role);
//         a sheet is minted only when the caller's OWN session reads its
//         document in that workspace and the version belongs to it; only
//         the token's SHA-256 is written; before the paste (42P01 /
//         PGRST205) it answers { available: false } so the print keeps
//         today's QR; any other refusal is a 503 (the print keeps today's QR).
//   settle: only the minter, only once; sheets not in the PDF are voided
//         'not_printed', an empty list voids the print 'print_aborted';
//         every write is count-checked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashSheetToken } from "@/lib/printSheetTokensServer";
import { isSheetToken } from "@/lib/printSheetTokens";

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const D1 = "d1d1d1d1-0000-0000-0000-000000000001";
const D2 = "d2d2d2d2-0000-0000-0000-000000000002";
const D3 = "d3d3d3d3-0000-0000-0000-000000000003";
const V1 = "e1e1e1e1-0000-0000-0000-000000000001";
const V2 = "e2e2e2e2-0000-0000-0000-000000000002";
const V3 = "e3e3e3e3-0000-0000-0000-000000000003";
const PRINT = "f0f0f0f0-0000-0000-0000-000000000000";
const UID = "c0c0c0c0-0000-0000-0000-000000000000";

const state = vi.hoisted(() => ({
  auth: null as null | { error: string; status: number },
  /** documents the CALLER's session can read */
  callerDocs: [] as Array<{ id: string; org_id: string }>,
  callerError: null as null | { message: string },
  versions: [] as Array<{ id: string; record_id: string }>,
  insertError: null as null | { code?: string; message: string },
  tokenRows: [] as Array<{ id: string; document_id: string }>,
  tokenReadError: null as null | { code?: string; message: string },
  /** rows an update returns (by call order); default: every row it targets */
  updateShort: false,
  inserts: [] as Array<{ table: string; rows: unknown }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  callerTables: [] as string[],
  /** the per-member mint window: sheets this member minted in the last hour */
  windowCount: 0 as number | null,
  windowError: null as null | { code?: string; message: string },
  windowReads: [] as Array<{ filters: Array<[string, string, unknown]>; count: unknown }>,
}));

function chain(table: string, who: "admin" | "caller") {
  const filters: Array<[string, string, unknown]> = [];
  let op: "select" | "insert" | "update" = "select";
  let patch: Record<string, unknown> = {};
  let selectOpts: { count?: string } | undefined;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (op === "insert") return resolve({ data: null, error: state.insertError });
          if (op === "update") {
            state.updates.push({ table, patch, filters: [...filters] });
            const ids = filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[] | undefined;
            const n = ids ? ids.length : state.tokenRows.length - (state.updates.filter((u) => u.filters.some((f) => f[1] === "id")).reduce((a, u) => a + ((u.filters.find((f) => f[1] === "id")?.[2] as string[]).length), 0));
            const count = state.updateShort ? Math.max(0, n - 1) : n;
            return resolve({ data: Array.from({ length: count }, (_, i) => ({ id: `r${i}` })), error: null });
          }
          if (who === "caller" && table === "documents") {
            const ids = filters.find((f) => f[0] === "in")?.[2] as string[];
            return resolve(state.callerError ? { data: null, error: state.callerError } : { data: state.callerDocs.filter((d) => ids.includes(d.id)), error: null });
          }
          if (table === "document_versions") {
            const ids = filters.find((f) => f[0] === "in")?.[2] as string[];
            return resolve({ data: state.versions.filter((v) => ids.includes(v.id)), error: null });
          }
          if (table === "print_sheet_tokens" && selectOpts?.count) {
            state.windowReads.push({ filters: [...filters], count: selectOpts.count });
            return resolve(state.windowError ? { data: null, count: null, error: state.windowError } : { data: [], count: state.windowCount, error: null });
          }
          if (table === "print_sheet_tokens") {
            return resolve(state.tokenReadError ? { data: null, error: state.tokenReadError } : { data: state.tokenRows, error: null });
          }
          return resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (who === "caller" && p === "select") state.callerTables.push(table);
        if (p === "select") selectOpts = args[1] as { count?: string } | undefined;
        if (p === "insert") { op = "insert"; state.inserts.push({ table, rows: args[0] }); }
        if (p === "update") { op = "update"; patch = args[0] as Record<string, unknown>; }
        if (p === "eq" || p === "in" || p === "is" || p === "gte") filters.push([p, String(args[0]), args[1]]);
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: async (_req: Request, orgId: string, roles: string[]) => {
    if (state.auth) return state.auth;
    if (!orgId) return { error: "orgId is required", status: 400 };
    // every role admitted — the route asks over the whole roster
    if (!roles.includes("Viewer") || !roles.includes("Admin")) return { error: "Insufficient role", status: 403 };
    return { userId: UID, email: "u@x", orgId, role: "Viewer", roles: ["Viewer"], admin: { from: (t: string) => chain(t, "admin") } };
  },
  callerScopedClient: () => ({ from: (t: string) => chain(t, "caller") }),
}));

beforeEach(() => {
  state.auth = null;
  state.callerDocs = [{ id: D1, org_id: ORG }, { id: D2, org_id: ORG }, { id: D3, org_id: OTHER_ORG }];
  state.callerError = null;
  state.versions = [{ id: V1, record_id: D1 }, { id: V2, record_id: D2 }, { id: V3, record_id: D1 }];
  state.insertError = null;
  state.tokenRows = [];
  state.tokenReadError = null;
  state.updateShort = false;
  state.inserts = [];
  state.updates = [];
  state.callerTables = [];
  state.windowCount = 0;
  state.windowError = null;
  state.windowReads = [];
});

async function post(body: unknown) {
  const { POST } = await import("@/app/api/print-sheet-tokens/route");
  return POST(new NextRequest("https://app/api/print-sheet-tokens", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer x" } }));
}

describe("PS-P9 mint", () => {
  it("mints one token per sheet the caller may print here; writes only the hash, the print, the org, the document, the version and the minter", async () => {
    const res = await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { available: boolean; printId: string; tokens: Record<string, string> };
    expect(body.available).toBe(true);
    expect(Object.keys(body.tokens).sort()).toEqual([D1, D2]);
    for (const t of Object.values(body.tokens)) expect(isSheetToken(t)).toBe(true);
    const rows = state.inserts[0].rows as Array<Record<string, unknown>>;
    expect(state.inserts[0].table).toBe("print_sheet_tokens");
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([
      ["document_id", "minted_by", "org_id", "print_id", "token_hash", "version_id"],
      ["document_id", "minted_by", "org_id", "print_id", "token_hash", "version_id"],
    ]);
    expect(rows[0]).toMatchObject({ token_hash: hashSheetToken(body.tokens[D1]), print_id: body.printId, org_id: ORG, document_id: D1, version_id: V1, minted_by: UID });
    // the bearer token itself is never written
    expect(JSON.stringify(rows)).not.toContain(body.tokens[D1]);
    // the readability check ran AS THE CALLER (RLS judges it)
    expect(state.callerTables).toEqual(["documents"]);
  });

  it("a sheet the caller cannot read, one in another workspace, or a version of another document gets no token (it keeps today's QR)", async () => {
    state.callerDocs = [{ id: D1, org_id: ORG }, { id: D3, org_id: OTHER_ORG }]; // D2 unreadable
    const res = await post({ action: "mint", orgId: ORG, sheets: [
      { documentId: D1, versionId: V2 }, // V2 belongs to D2
      { documentId: D2, versionId: V2 }, // unreadable
      { documentId: D3, versionId: V3 }, // other workspace
    ] });
    const body = (await res.json()) as { available: boolean; tokens: Record<string, string> };
    expect(body).toMatchObject({ available: true, tokens: {} });
    expect(state.inserts).toEqual([]);
  });

  it("before 20261237 is pasted the route answers { available: false } — the print keeps today's QR, nothing breaks", async () => {
    state.insertError = { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" };
    const res = await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    state.insertError = { code: "42P01", message: 'relation "print_sheet_tokens" does not exist' };
    expect(await (await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).json()).toEqual({ available: false });
  });

  it("any other refusal is a 503 (never a token the table does not hold); an unreadable check is a 503 too", async () => {
    state.insertError = { code: "23505", message: "duplicate key" };
    expect((await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).status).toBe(503);
    state.insertError = null;
    state.callerError = { message: "boom" };
    expect((await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).status).toBe(503);
    expect(state.inserts.length).toBe(1);
  });

  it("the per-member window: a member's sheets minted in the last hour, plus this pack's, stay under the cap — over it the mint is 429 and nothing is written (the pack keeps today's QR)", async () => {
    const { SHEET_TOKEN_MINT_WINDOW_MAX, SHEET_TOKEN_MINT_WINDOW_MS } = await import("@/lib/printSheetTokensServer");
    expect(SHEET_TOKEN_MINT_WINDOW_MS).toBe(60 * 60 * 1000);
    const two = [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }];
    // exactly at the cap is allowed
    state.windowCount = SHEET_TOKEN_MINT_WINDOW_MAX - 2;
    const before = Date.now();
    expect((await post({ action: "mint", orgId: ORG, sheets: two })).status).toBe(200);
    expect(state.inserts).toHaveLength(1);
    // the window counted THIS member's mints since an hour ago
    const read = state.windowReads[0];
    expect(read.count).toBe("exact");
    expect(read.filters.find((f) => f[0] === "eq" && f[1] === "minted_by")?.[2]).toBe(UID);
    const since = Date.parse(String(read.filters.find((f) => f[0] === "gte" && f[1] === "minted_at")?.[2]));
    expect(since).toBeGreaterThanOrEqual(before - SHEET_TOKEN_MINT_WINDOW_MS - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - SHEET_TOKEN_MINT_WINDOW_MS + 1000);
    // one over is refused
    state.windowCount = SHEET_TOKEN_MINT_WINDOW_MAX - 1;
    const res = await post({ action: "mint", orgId: ORG, sheets: two });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/today's QR/);
    expect(state.inserts).toHaveLength(1);
  });

  it("the window read: before the paste it is { available: false }; any other failure is a 503 and nothing is written", async () => {
    state.windowError = { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" };
    expect(await (await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).json()).toEqual({ available: false });
    state.windowError = { code: "57014", message: "canceling statement due to statement timeout" };
    expect((await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).status).toBe(503);
    expect(state.inserts).toEqual([]);
  });

  it("refuses a caller who is not an active member, and a malformed request", async () => {
    state.auth = { error: "Not a member of this org", status: 403 };
    expect((await post({ action: "mint", orgId: ORG, sheets: [{ documentId: D1, versionId: V1 }] })).status).toBe(403);
    state.auth = null;
    expect((await post({ action: "mint", orgId: ORG, sheets: [] })).status).toBe(400);
    expect((await post({ action: "mint", orgId: ORG, sheets: [{ documentId: "x", versionId: V1 }] })).status).toBe(400);
    expect((await post({ action: "mint", orgId: ORG, sheets: Array.from({ length: 1001 }, () => ({ documentId: D1, versionId: V1 })) })).status).toBe(400);
    expect((await post({ action: "nope", orgId: ORG })).status).toBe(400);
    expect(state.inserts).toEqual([]);
  });
});

describe("PS-P9 settle", () => {
  it("voids the tokens of sheets that are not in the PDF ('not_printed'); the printed ones are settled and stay live", async () => {
    state.tokenRows = [{ id: "t1", document_id: D1 }, { id: "t2", document_id: D2 }];
    const res = await post({ action: "settle", orgId: ORG, printId: PRINT, printed: [D1] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true, voided: 1 });
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0].patch).toMatchObject({ void_reason: "not_printed" });
    expect(state.updates[0].filters).toContainEqual(["in", "id", ["t2"]]);
    expect(state.updates[0].filters).toContainEqual(["is", "settled_at", null]);
    expect(Object.keys(state.updates[1].patch)).toEqual(["settled_at"]);
    // only the minter's, only this org's, only once
    expect(state.updates[1].filters).toEqual(expect.arrayContaining([["eq", "print_id", PRINT], ["eq", "org_id", ORG], ["eq", "minted_by", UID], ["is", "settled_at", null]]));
  });

  it("an empty list voids the whole print ('print_aborted' — nothing was downloaded)", async () => {
    state.tokenRows = [{ id: "t1", document_id: D1 }, { id: "t2", document_id: D2 }];
    const res = await post({ action: "settle", orgId: ORG, printId: PRINT, printed: [] });
    expect(await res.json()).toEqual({ settled: true, voided: 2 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch).toMatchObject({ void_reason: "print_aborted" });
  });

  it("an unknown or already-settled print is 404; a short write is a 409, never a silent success", async () => {
    expect((await post({ action: "settle", orgId: ORG, printId: PRINT, printed: [D1] })).status).toBe(404);
    state.tokenRows = [{ id: "t1", document_id: D1 }, { id: "t2", document_id: D2 }];
    state.updateShort = true;
    expect((await post({ action: "settle", orgId: ORG, printId: PRINT, printed: [D1] })).status).toBe(409);
  });

  it("before the paste a settle says so and changes nothing; a malformed print id is 400", async () => {
    state.tokenReadError = { code: "42P01", message: "relation does not exist" };
    expect(await (await post({ action: "settle", orgId: ORG, printId: PRINT, printed: [D1] })).json()).toEqual({ available: false, settled: false });
    expect((await post({ action: "settle", orgId: ORG, printId: "x", printed: [] })).status).toBe(400);
    expect(state.updates).toEqual([]);
  });
});
