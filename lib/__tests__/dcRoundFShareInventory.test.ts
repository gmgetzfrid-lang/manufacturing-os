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
}));

/** The service-role client handed to the route by authorizeOrgRole. */
function adminChain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let limit = Infinity;
  const rows = () => (s.tables[table] ?? [])
    .filter((r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k])))
    .slice(0, limit);
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) =>
        resolve(s.errorTables.has(table) ? { data: null, error: { message: "boom" } } : { data: rows(), error: null });
      return (...args: unknown[]) => {
        s.calls.push({ table, method: prop, args });
        if (prop === "eq") eqs.push([String(args[0]), args[1]]);
        if (prop === "in") ins.push([String(args[0]), args[1] as unknown[]]);
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
  SHARE_INVENTORY_DENIED, SHARE_INVENTORY_LIMIT, type ShareInventoryRow,
} from "@/lib/shareInventory";
import { isControllerRole } from "@/lib/permissions";
import { ALL_ROLES } from "@/types/schema";
import { adminSurface } from "@/lib/adminSurfaces";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const get = (orgId = "o1") => GET(new NextRequest(`http://x/api/share/inventory?orgId=${orgId}`, { headers: { authorization: "Bearer t" } }));
const FUTURE = new Date(Date.now() + 5 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

beforeEach(() => {
  s.actor = null; s.allowedSeen = []; s.calls = []; s.errorTables = new Set();
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

  it("fails closed: a failed read is a 500, never an empty inventory; more rows than the limit say so", async () => {
    s.actor = { userId: "c1", roles: ["Admin"] };
    s.errorTables.add("org_members");
    expect((await get()).status).toBe(500);
    s.errorTables = new Set(["document_shares"]);
    expect((await get()).status).toBe(500);
    s.errorTables = new Set();
    s.tables.document_shares = Array.from({ length: SHARE_INVENTORY_LIMIT + 1 }, (_, i) => ({
      id: `b${i}`, org_id: "o1", document_id: "d1", created_by: "u-eng", created_at: "2026-09-20T00:00:00Z", expires_at: FUTURE, revoked_at: null,
    }));
    const body = await (await get()).json() as { rows: ShareInventoryRow[]; truncated: boolean };
    expect(body.rows).toHaveLength(SHARE_INVENTORY_LIMIT);
    expect(body.truncated).toBe(true);
    expect(s.calls.find((c) => c.table === "document_shares" && c.method === "limit")!.args[0]).toBe(SHARE_INVENTORY_LIMIT + 1);
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
    // a refused row and a refused audit row are both shown
    expect(page).toMatch(/result\.failed\.length > 0/);
    expect(page).toMatch(/result\.auditWarnings\.length > 0/);
  });
});
