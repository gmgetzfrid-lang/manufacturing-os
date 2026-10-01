// document-control Round F wave 2 — P12 WAVE-2 RESIDUALS, DIST-15: the
// org-wide share-link inventory (Admin → Share links).
//
//   * GET /api/share/inventory — the controller tier by the role COLLECTION
//     (ALL_ROLES.filter(isControllerRole), no literal), everyone else refused;
//     every row in the org with its document, library, creator (and whether
//     they are still an active member), expiry and access count — never a
//     token; truncation stated; a failed read is a 500, never an empty list.
//   * revokeShareLinks — the real revokeShareLink per row: each revoked link
//     writes its own SHARE_LINK_REVOKED audit row; a refused row is reported
//     and the rest continue.
//   * the selection rules (selected / by creator / on a document / in a
//     library — live links only) and the order (live first).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  actor: null as null | { userId: string; roles: string[] },
  allowedSeen: [] as string[][],
  tables: {} as Record<string, Row[]>,
  errorTables: new Set<string>(),
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  // the client side (revokeShareLink through @/lib/supabase)
  shares: [] as Row[],
  refuse: new Set<string>(),
  audits: [] as Row[],
  /** PostgREST's max-rows for the service-role reads (Infinity: none). */
  maxRows: Infinity,
}));

/** One PostgREST filter term: `col.is.null`, `col.not.is.null`, `col.gt.X`, `col.lte.X`. */
function term(r: Row, t: string): boolean {
  const m = t.match(/^(\w+)\.(not\.is|is|gt|lte)\.(.*)$/);
  if (!m) throw new Error(`unsupported filter term ${t}`);
  const v = r[m[1]];
  switch (m[2]) {
    case "is": return m[3] === "null" && v == null;
    case "not.is": return m[3] === "null" && v != null;
    case "gt": return v != null && String(v) > m[3];
    case "lte": return v != null && String(v) <= m[3];
  }
  return false;
}
/** The service-role client handed to the route by authorizeOrgRole. */
function adminChain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const isNull: string[] = [];
  const gts: Array<[string, string]> = [];
  const ors: string[] = [];
  const orders: Array<[string, boolean]> = [];
  let limit = Infinity;
  const rows = () => (s.tables[table] ?? [])
    .filter((r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k]))
      && isNull.every((k) => r[k] == null) && gts.every(([k, v]) => String(r[k]) > v)
      && ors.every((o) => o.split(",").some((t) => term(r, t))))
    .sort((a, b) => {
      for (const [k, asc] of orders) {
        const c = String(a[k] ?? "").localeCompare(String(b[k] ?? ""));
        if (c !== 0) return asc ? c : -c;
      }
      return 0;
    })
    .slice(0, Math.min(limit, s.maxRows));
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) =>
        resolve(s.errorTables.has(table) ? { data: null, error: { message: "boom" } } : { data: rows(), error: null });
      return (...args: unknown[]) => {
        s.calls.push({ table, method: prop, args });
        if (prop === "eq") eqs.push([String(args[0]), args[1]]);
        if (prop === "in") ins.push([String(args[0]), args[1] as unknown[]]);
        if (prop === "is") { expect(args[1]).toBeNull(); isNull.push(String(args[0])); }
        if (prop === "gt") gts.push([String(args[0]), String(args[1])]);
        if (prop === "or") ors.push(String(args[0]));
        if (prop === "order") orders.push([String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false]);
        if (prop === "limit") limit = Number(args[0]);
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: Request, orgId: string, allowed: string[]) => {
    s.allowedSeen.push(allowed);
    const a = s.actor;
    if (!a) return { error: "Missing access token", status: 401 };
    if (!a.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
    return { userId: a.userId, email: "x@x.io", orgId, role: a.roles[0], roles: a.roles, admin: { from: (t: string) => adminChain(t) } };
  }),
}));

/** The browser client revokeShareLink and logAuditAction use. */
vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    let op = "select";
    let patch: Row = {};
    const eqs: Array<[string, unknown]> = [];
    const isNull: string[] = [];
    const settle = () => {
      if (table === "audit_logs") return { data: null, error: null };
      const match = s.shares.filter((r) => eqs.every(([k, v]) => r[k] === v) && isNull.every((k) => r[k] == null));
      if (op === "update") {
        const hit = match.filter((r) => !s.refuse.has(String(r.id)));
        for (const r of hit) Object.assign(r, patch);
        return { data: hit.map((r) => ({ id: r.id, org_id: r.org_id, document_id: r.document_id })), error: null };
      }
      return { data: match, error: null };
    };
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(settle());
        return (...args: unknown[]) => {
          if (prop === "insert" && table === "audit_logs") { s.audits.push(args[0] as Row); op = "insert"; }
          if (prop === "update") { op = "update"; patch = args[0] as Row; }
          if (prop === "eq") eqs.push([String(args[0]), args[1]]);
          if (prop === "is") isNull.push(String(args[0]));
          if (prop === "maybeSingle") return Promise.resolve({ data: (settle().data as Row[])[0] ?? null, error: null });
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from, rpc: async () => ({ data: null, error: null }), auth: { getSession: async () => ({ data: { session: null } }) } } };
});

import { GET } from "@/app/api/share/inventory/route";
import { revokeShareLink } from "@/lib/documentShares";
import {
  revokeShareLinks, shareBulkTargets, shareLinkState, sortShareInventory,
  SHARE_INVENTORY_DENIED, SHARE_INVENTORY_IN_CHUNK, SHARE_INVENTORY_LIMIT, SHARE_INVENTORY_LIVE_CEILING, type ShareInventoryRow,
} from "@/lib/shareInventory";
import { isControllerRole } from "@/lib/permissions";
import { ALL_ROLES } from "@/types/schema";
import { adminSurface } from "@/lib/adminSurfaces";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const get = (orgId = "o1") => GET(new NextRequest(`http://x/api/share/inventory?orgId=${orgId}`, { headers: { authorization: "Bearer t" } }));
const FUTURE = new Date(Date.now() + 5 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

beforeEach(() => {
  s.actor = null; s.allowedSeen = []; s.calls = []; s.errorTables = new Set(); s.maxRows = Infinity;
  s.tables = {
    document_shares: [
      { id: "s1", org_id: "o1", document_id: "d1", token: "SECRET-1", created_by: "u-gone", created_by_name: "Contractor", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null, revoked_by: null, access_count: 4, access_last_at: "2026-09-25T00:00:00Z", note: "for the fabricator" },
      { id: "s2", org_id: "o1", document_id: "d2", token: "SECRET-2", created_by: "u-eng", created_by_name: "Lead engineer", created_at: "2026-09-21T00:00:00Z", expires_at: PAST, revoked_at: null, revoked_by: null, access_count: 0, access_last_at: null, note: null },
      { id: "s9", org_id: "o2", document_id: "d9", token: "OTHER-ORG", created_by: "u-x", created_by_name: "x", created_at: "2026-09-22T00:00:00Z", expires_at: FUTURE, revoked_at: null },
    ],
    documents: [
      { id: "d1", org_id: "o1", document_number: "P-101", title: "Overhead P&ID", status: "Issued", library_id: "L1" },
      { id: "d2", org_id: "o1", document_number: "ISO-7", title: "Isometric 7", status: "Issued", library_id: "L1" },
    ],
    libraries: [{ id: "L1", org_id: "o1", name: "Piping" }],
    org_members: [
      { org_id: "o1", uid: "u-eng", status: "active" },
      { org_id: "o1", uid: "u-gone", status: "removed" },
    ],
  };
  s.shares = []; s.refuse = new Set(); s.audits = [];
});

describe("DIST-15 — GET /api/share/inventory: the listing decision", () => {
  it("asks for the controller tier as isControllerRole defines it — the predicate, not a literal role list", async () => {
    s.actor = { userId: "c1", roles: ["DocCtrl"] };
    await get();
    expect(s.allowedSeen[0]).toEqual(ALL_ROLES.filter((r) => isControllerRole(r)));
    const route = src("app/api/share/inventory/route.ts");
    expect(route).toMatch(/const CONTROLLER_ROLES = ALL_ROLES\.filter\(\(r\) => isControllerRole\(r\)\);/);
    expect(route).not.toMatch(/"Admin"|"DocCtrl"/);
  });

  it("a controller — by an ADDITIVE role under another headline — sees every link in the org with its document, library, creator and counts", async () => {
    s.actor = { userId: "c1", roles: ["Manager", "DocCtrl"] };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: ShareInventoryRow[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.rows.map((r) => r.id)).toEqual(["s1", "s2"]); // the other org's row is not listed
    expect(body.rows[0]).toEqual({
      id: "s1", documentId: "d1", documentNumber: "P-101", documentTitle: "Overhead P&ID", documentStatus: "Issued",
      libraryId: "L1", libraryName: "Piping", createdBy: "u-gone", createdByName: "Contractor", creatorActive: false,
      createdAt: "2026-09-20T00:00:00Z", expiresAt: FUTURE, revokedAt: null, revokedBy: null,
      accessCount: 4, accessLastAt: "2026-09-25T00:00:00Z", note: "for the fabricator",
    });
    expect(body.rows[1]).toMatchObject({ id: "s2", createdBy: "u-eng", creatorActive: true, accessCount: 0 });
    // every read is scoped to the org
    for (const t of ["document_shares", "documents", "libraries", "org_members"]) {
      expect(s.calls.some((c) => c.table === t && c.method === "eq" && c.args[0] === "org_id" && c.args[1] === "o1"), t).toBe(true);
    }
  });

  it("never returns a token — not selected, not in any row", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    const text = await (await get()).text();
    expect(text).not.toMatch(/SECRET|token/);
    const select = s.calls.find((c) => c.table === "document_shares" && c.method === "select")!;
    expect(String(select.args[0])).not.toMatch(/token/);
  });

  it("a member below the controller tier is refused with the reason, and nothing is read", async () => {
    s.actor = { userId: "e1", roles: ["Engineer-1", "Drafter"] };
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(SHARE_INVENTORY_DENIED);
    expect(s.calls).toEqual([]);
    s.actor = null;
    expect((await get()).status).toBe(401);
    expect((await GET(new NextRequest("http://x/api/share/inventory?orgId=", { headers: { authorization: "Bearer t" } }))).status).toBe(400);
  });

  it("fails closed: a failed read is a 500, never an empty inventory", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    for (const t of ["org_members", "documents", "libraries", "document_shares"]) {
      s.errorTables = new Set([t]);
      expect((await get()).status, t).toBe(500);
    }
  });

  it("EVERY live link is listed, however many expired / revoked rows are newer — only the history is capped, and `truncated` says so (DIST-15 done-when 1)", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    const pad = (i: number) => String(i).padStart(5, "0");
    // SHARE_INVENTORY_LIMIT + 5 revoked rows, all NEWER than the three live ones
    const revoked = Array.from({ length: SHARE_INVENTORY_LIMIT + 5 }, (_, i) => ({
      id: `r${pad(i)}`, org_id: "o1", document_id: "d2", created_by: "u-eng", created_at: `2026-09-28T00:00:00.${pad(i)}Z`,
      expires_at: FUTURE, revoked_at: "2026-09-29T00:00:00Z",
    }));
    const liveOld = ["l1", "l2", "l3"].map((id) => ({
      id, org_id: "o1", document_id: "d1", created_by: "u-gone", created_at: "2026-01-01T00:00:00Z", expires_at: id === "l3" ? null : FUTURE, revoked_at: null,
    }));
    s.tables.document_shares = [...revoked, ...liveOld];
    const body = await (await get()).json() as { rows: ShareInventoryRow[]; truncated: boolean };
    const live = body.rows.filter((r) => shareLinkState(r) === "live").map((r) => r.id).sort();
    expect(live).toEqual(["l1", "l2", "l3"]); // a never-expiring legacy link is live too
    expect(body.rows.filter((r) => shareLinkState(r) === "revoked")).toHaveLength(SHARE_INVENTORY_LIMIT);
    expect(body.truncated).toBe(true);
    // the bulk scope "every live link by u-gone" therefore names all three
    expect(shareBulkTargets(body.rows, { kind: "creator", createdBy: "u-gone" }).sort()).toEqual(["l1", "l2", "l3"]);
  });

  it("live links are read in keyset pages until an EMPTY page — never cut at PostgREST's row ceiling, whatever max-rows the project sets", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    const n = 2 * 1000 + 37;
    s.tables.document_shares = Array.from({ length: n }, (_, i) => ({
      id: `s${String(i).padStart(5, "0")}`, org_id: "o1", document_id: "d1", created_by: "u-eng", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    const body = await (await get()).json() as { rows: ShareInventoryRow[]; truncated: boolean };
    expect(body.rows).toHaveLength(n);
    expect(new Set(body.rows.map((r) => r.id)).size).toBe(n);
    expect(body.truncated).toBe(false);
    // live pages of 1000, each after the last id of the one before, until an empty one; then the capped history read
    const limits = s.calls.filter((c) => c.table === "document_shares" && c.method === "limit").map((c) => c.args[0]);
    expect(limits).toEqual([1000, 1000, 1000, 1000, SHARE_INVENTORY_LIMIT + 1]);
    expect(s.calls.filter((c) => c.table === "document_shares" && c.method === "gt").map((c) => c.args)).toEqual([
      ["id", "s00999"], ["id", "s01999"], ["id", "s02036"],
    ]);
    expect(SHARE_INVENTORY_LIVE_CEILING).toBeGreaterThan(n);
  });

  it("a server whose max-rows is BELOW the page size still yields every live link (a short page is not the end)", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    s.maxRows = 250;
    const n = 777;
    s.tables.document_shares = Array.from({ length: n }, (_, i) => ({
      id: `s${String(i).padStart(5, "0")}`, org_id: "o1", document_id: "d1", created_by: "u-eng", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    const body = await (await get()).json() as { rows: ShareInventoryRow[] };
    expect(body.rows).toHaveLength(n);
  });

  it("past SHARE_INVENTORY_LIVE_CEILING live links the route refuses (500) rather than list a part", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    s.tables.document_shares = Array.from({ length: SHARE_INVENTORY_LIVE_CEILING + 1 }, (_, i) => ({
      id: `s${String(i).padStart(6, "0")}`, org_id: "o1", document_id: "d1", created_by: "u-eng", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/more than 50000 live share links/);
  });

  it("an org with hundreds of shared documents: no `.in()` carries more than SHARE_INVENTORY_IN_CHUNK ids, and every row is still joined (DIST-15 — the URL-length 500)", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    const n = 2 * SHARE_INVENTORY_IN_CHUNK + 13;
    s.tables.document_shares = Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, org_id: "o1", document_id: `doc${i}`, created_by: `u${i}`, created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    s.tables.documents = Array.from({ length: n }, (_, i) => ({ id: `doc${i}`, org_id: "o1", document_number: `N-${i}`, title: "t", status: "Issued", library_id: `L${i}` }));
    s.tables.libraries = Array.from({ length: n }, (_, i) => ({ id: `L${i}`, org_id: "o1", name: `Lib ${i}` }));
    s.tables.org_members = Array.from({ length: n }, (_, i) => ({ org_id: "o1", uid: `u${i}`, status: "active" }));
    const body = await (await get()).json() as { rows: ShareInventoryRow[] };
    expect(body.rows).toHaveLength(n);
    for (const r of body.rows) {
      const i = Number(r.id.slice(1));
      expect(r).toMatchObject({ documentNumber: `N-${i}`, libraryName: `Lib ${i}`, creatorActive: true });
    }
    const ins = s.calls.filter((c) => c.method === "in");
    for (const t of ["documents", "libraries", "org_members"]) {
      const calls = ins.filter((c) => c.table === t);
      expect(calls.length, t).toBe(3);
      for (const c of calls) expect((c.args[1] as unknown[]).length, t).toBeLessThanOrEqual(SHARE_INVENTORY_IN_CHUNK);
      expect(calls.flatMap((c) => c.args[1] as unknown[])).toHaveLength(n);
    }
  });

  it("a chunk that fails fails the whole inventory closed (a 500, never a partly-joined list)", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    s.tables.document_shares = Array.from({ length: SHARE_INVENTORY_IN_CHUNK + 1 }, (_, i) => ({
      id: `s${i}`, org_id: "o1", document_id: `doc${i}`, created_by: "u-eng", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    s.errorTables = new Set(["documents"]);
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to load the shared documents");
  });
});

describe("DIST-15 — the bulk revoke goes through revokeShareLink, one audited revoke per row", () => {
  it("revokes each live link, writes one SHARE_LINK_REVOKED row per revoked link, and reports the refused one", async () => {
    s.shares = [
      { id: "s1", org_id: "o1", document_id: "d1", revoked_at: null },
      { id: "s2", org_id: "o1", document_id: "d2", revoked_at: null },
      { id: "s3", org_id: "o1", document_id: "d3", revoked_at: null },
    ];
    s.refuse.add("s3"); // the UPDATE policy turns it into zero rows
    const out = await revokeShareLinks(["s1", "s2", "s3"], "c1", revokeShareLink);
    expect(out.revoked).toEqual(["s1", "s2"]);
    expect(out.failed).toEqual([{ id: "s3", reason: expect.stringMatching(/was not revoked/) }]);
    expect(out.auditWarnings).toEqual([]);
    expect(s.shares.find((r) => r.id === "s1")).toMatchObject({ revoked_by: "c1" });
    expect(s.shares.find((r) => r.id === "s3")!.revoked_at).toBeNull();
    expect(s.audits.map((a) => [a.action, (a.details as Row).shareId, a.resource_id])).toEqual([
      ["SHARE_LINK_REVOKED", "s1", "d1"],
      ["SHARE_LINK_REVOKED", "s2", "d2"],
    ]);
  });

  it("a revoke whose audit row is refused still counts as revoked and carries the warning", async () => {
    const revoke = vi.fn(async (id: string) => ({ auditWarning: id === "s2" ? "audit refused" : null }));
    const out = await revokeShareLinks(["s1", "s2"], "c1", revoke);
    expect(out).toEqual({ revoked: ["s1", "s2"], failed: [], auditWarnings: ["audit refused"] });
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]); // in order, one call per row
  });
});

describe("DIST-15 — what a selection names, and the order", () => {
  const row = (id: string, over: Partial<ShareInventoryRow>): ShareInventoryRow => ({
    id, documentId: "d1", documentNumber: "P-101", documentTitle: null, documentStatus: "Issued", libraryId: "L1", libraryName: "Piping",
    createdBy: "u1", createdByName: null, creatorActive: true, createdAt: "2026-09-20T00:00:00Z", expiresAt: FUTURE,
    revokedAt: null, revokedBy: null, accessCount: 0, accessLastAt: null, note: null, ...over,
  });
  const rows = [
    row("live-u1-d1", {}),
    row("live-u2-d2", { createdBy: "u2", documentId: "d2", libraryId: "L2", createdAt: "2026-09-25T00:00:00Z" }),
    row("expired-u1", { expiresAt: PAST }),
    row("revoked-u1", { revokedAt: "2026-09-22T00:00:00Z" }),
    row("legacy-never", { expiresAt: null, createdBy: "u3", documentId: "d3", libraryId: "L2" }),
  ];
  it("a link is live until revoked or past its expiry (a legacy never-expiring row is live)", () => {
    expect(rows.map((r) => shareLinkState(r))).toEqual(["live", "live", "expired", "revoked", "live"]);
  });
  it("each scope names only LIVE links: selected, by creator, on a document, in a library", () => {
    expect(shareBulkTargets(rows, { kind: "selected", ids: ["live-u1-d1", "expired-u1", "revoked-u1"] })).toEqual(["live-u1-d1"]);
    expect(shareBulkTargets(rows, { kind: "creator", createdBy: "u1" })).toEqual(["live-u1-d1"]);
    expect(shareBulkTargets(rows, { kind: "document", documentId: "d2" })).toEqual(["live-u2-d2"]);
    expect(shareBulkTargets(rows, { kind: "library", libraryId: "L2" })).toEqual(["live-u2-d2", "legacy-never"]);
  });
  it("live links first, then expired, then revoked; newest first within each", () => {
    expect(sortShareInventory(rows).map((r) => r.id)).toEqual(["live-u2-d2", "live-u1-d1", "legacy-never", "expired-u1", "revoked-u1"]);
  });
});

describe("DIST-15 — the page", () => {
  const page = src("app/(protected)/admin/shares/page.tsx");
  it("is registered with the admin gate; its authority is the server's, so it spells no role list", () => {
    expect(adminSurface("shares")).toMatchObject({ path: "/admin/shares", entry: "*" });
    expect(adminSurface("shares")!.writes).toBeUndefined();
    expect(page).not.toMatch(/"Admin"|"DocCtrl"|hasAnyRole\(/);
  });
  it("reads the server inventory and revokes only through revokeShareLinks(…, revokeShareLink), after a confirmation naming the count", () => {
    expect(page).toMatch(/const inv = await loadShareInventory\(activeOrgId, session\?\.access_token\);/);
    expect(page).toMatch(/setResult\(await revokeShareLinks\(ids, uid, revokeShareLink\)\);/);
    expect(page).toMatch(/const ids = shareBulkTargets\(rows, sel\);/);
    expect(page).toMatch(/title: `Revoke \$\{ids\.length\} share link/);
    expect(page).not.toMatch(/from\("document_shares"\)/);
    // the four scopes and the leaver mark are offered
    for (const k of ['kind: "selected"', 'kind: "creator"', 'kind: "document"', 'kind: "library"']) expect(page).toContain(k);
    expect(page).toMatch(/no longer an active member/);
    // truncation is about the history only; every live link is listed
    expect(page).toMatch(/Every live link is listed\. Of the expired and revoked links, only the newest \{SHARE_INVENTORY_LIMIT\} are shown\./);
    expect(page).not.toMatch(/older ones are not listed here/);
    // a refused row and a refused audit row are both shown
    expect(page).toMatch(/result\.failed\.length > 0/);
    expect(page).toMatch(/result\.auditWarnings\.length > 0/);
  });
});
