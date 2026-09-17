// EGRESS-8 — listShareLinks exposed live tokens to members who cannot read
// the document.
//
//   * /api/share/list lists a document's shares under the CALLER's own read
//     decision: readable → every row with tokens; not readable → only the
//     caller's own rows, every token withheld; not a member → the SAME 404 as
//     a document that does not exist (no cross-org existence oracle). The
//     decision fails CLOSED on a lookup error.
//   * lib/documentShares.listShareLinks goes through that route (no more
//     client-side SELECT of document_shares), and the modal renders no URL,
//     copy, QR or open for a share whose token was withheld.
//   * 20261066 re-creates document_shares_org_select with the same rule —
//     membership AND (creator OR document readable) — carrying the
//     read-decision block byte-for-byte from the 20261037 INSERT policy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: null as null | { id: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  principal: null as null | { uid: string; orgId: string; role: string; roles: string[]; isController: boolean; teamIds: string[] },
  readable: new Set<string>(),
  readableThrows: false,
  readableCalls: 0,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => state.principal),
  readableControlledDocIds: vi.fn(async () => {
    state.readableCalls++;
    if (state.readableThrows) throw new Error("db down");
    return state.readable;
  }),
}));
import { GET } from "@/app/api/share/list/route";

const get = (documentId: string, auth: string | null = "Bearer t") =>
  GET(new NextRequest(`http://x/api/share/list?documentId=${documentId}`, { headers: auth ? { authorization: auth } : {} }));
const member = (uid: string, isController = false) => ({ uid, orgId: "o1", role: isController ? "DocCtrl" : "Drafter", roles: [isController ? "DocCtrl" : "Drafter"], isController, teamIds: [] });
const share = (id: string, created_by: string, token: string) => ({
  id, token, org_id: "o1", document_id: "doc1", created_by, created_by_name: created_by, created_at: "2026-09-01T00:00:00Z",
  expires_at: null, revoked_at: null, revoked_by: null, note: null, access_count: 3, access_last_at: null,
});
const OTHERS_TOKEN = "tok-of-u2-" + "x".repeat(20);
const MINE_TOKEN = "tok-of-u1-" + "y".repeat(20);

beforeEach(() => {
  state.user = null; state.rows = {}; state.principal = null; state.readable = new Set();
  state.readableThrows = false; state.readableCalls = 0; state.calls = [];
  state.rows.documents = [{ id: "doc1", org_id: "o1" }];
  state.rows.document_shares = [share("s1", "u1", MINE_TOKEN), share("s2", "u2", OTHERS_TOKEN)];
});

describe("GET /api/share/list — the listing is gated by the caller's own read decision", () => {
  it("401 without a bearer token or with one that resolves to no user", async () => {
    expect((await get("doc1", null)).status).toBe(401);
    expect((await get("doc1", "Bearer nope")).status).toBe(401);
    expect(state.calls.filter((c) => c.table === "document_shares")).toHaveLength(0);
  });

  it("400 without a documentId; 404 for a document that does not exist", async () => {
    state.user = { id: "u1" };
    expect((await get("")).status).toBe(400);
    expect((await get("doc-missing")).status).toBe(404);
    expect(state.calls.filter((c) => c.table === "document_shares")).toHaveLength(0);
  });

  it("a caller who is not an active member of the document's org gets the SAME 404 as a missing document — no share row is read, no existence oracle", async () => {
    state.user = { id: "u9" };
    state.principal = null;
    const missing = await get("doc-missing");
    const foreign = await get("doc1");
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
    expect(state.calls.filter((c) => c.table === "document_shares")).toHaveLength(0);
    // the route never answers 403: nothing distinguishes "exists in another org" from "does not exist"
    const src = readFileSync(join(process.cwd(), "app/api/share/list/route.ts"), "utf8");
    expect(src).not.toMatch(/bad\([^)]*,\s*403\)/);
    expect(src.match(/bad\("Document not found", 404\)/g)).toHaveLength(2);
  });

  it("a member who can read the document gets every row, tokens included, org-joined", async () => {
    state.user = { id: "u1" };
    state.principal = member("u1");
    state.readable = new Set(["doc1"]);
    const res = await get("doc1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readable).toBe(true);
    expect(body.shares.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
    expect(body.shares.map((s: { token: string }) => s.token)).toEqual([MINE_TOKEN, OTHERS_TOKEN]);
    const q = state.calls.filter((c) => c.table === "document_shares" && c.method === "eq").map((c) => c.args);
    expect(q).toContainEqual(["document_id", "doc1"]);
    expect(q).toContainEqual(["org_id", "o1"]);
  });

  it("a member who CANNOT read the document gets only their own rows, and never a token — not even their own", async () => {
    state.user = { id: "u1" };
    state.principal = member("u1");
    state.readable = new Set(); // doc1 is not readable to u1
    const res = await get("doc1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(OTHERS_TOKEN);
    expect(text).not.toContain(MINE_TOKEN);
    const body = JSON.parse(text);
    expect(body.readable).toBe(false);
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].id).toBe("s1");
    expect(body.shares[0].token).toBeNull();
    // a member with no shares of their own on an unreadable document sees nothing at all
    state.user = { id: "u3" };
    state.principal = member("u3");
    const none = await (await get("doc1")).json();
    expect(none).toEqual({ readable: false, shares: [] });
  });

  it("a controller reads everything without a per-document ACL lookup (node_visible's short-circuit)", async () => {
    state.user = { id: "c1" };
    state.principal = member("c1", true);
    const body = await (await get("doc1")).json();
    expect(body.readable).toBe(true);
    expect(body.shares).toHaveLength(2);
    expect(state.readableCalls).toBe(0);
  });

  it("fails CLOSED: a read-decision lookup error is treated as 'cannot read'", async () => {
    state.user = { id: "u1" };
    state.principal = member("u1");
    state.readable = new Set(["doc1"]);
    state.readableThrows = true;
    const res = await get("doc1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(OTHERS_TOKEN);
    expect(text).not.toContain(MINE_TOKEN);
    expect(JSON.parse(text).readable).toBe(false);
  });
});

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the client lists through the route and renders no link it cannot use", () => {
  it("lib/documentShares.listShareLinks fetches /api/share/list with the session bearer; the client-side SELECT is gone", () => {
    const lib = src("lib/documentShares.ts");
    const listFn = lib.slice(lib.indexOf("export async function listShareLinks"), lib.indexOf("export async function revokeShareLink"));
    expect(listFn).toContain("fetch(`/api/share/list?documentId=${encodeURIComponent(documentId)}`");
    expect(listFn).toContain("Authorization: `Bearer ${session.access_token}`");
    expect(listFn).not.toMatch(/from\("document_shares"\)/);
    expect(listFn).toContain("return { readable: out.readable === true, shares: (out.shares ?? []).map(rowToShare) };");
    expect(lib).toMatch(/token: string \| null;/);
    expect(lib).toContain("token: (r.token as string | null) ?? null,");
    // the only client-side reads of document_shares left are the creator's own insert-returning row and the checked revoke
    expect(lib.match(/from\("document_shares"\)/g)).toHaveLength(2);
  });

  it("ShareLinkModal: no URL / copy / QR / open without a token; no Create panel when the document is unreadable; Revoke stays", () => {
    const m = src("components/documents/ShareLinkModal.tsx");
    expect(m).toContain("const [readable, setReadable] = useState(true);");
    expect(m).toContain("setReadable(listing.readable);");
    expect(m).toContain("const url = s.token ? `${baseUrl}${s.token}` : null;");
    expect(m).toContain("const usable = !!url && readable && !dead;");
    expect(m).toContain("{usable && url && (");
    expect(m).toContain("{qrFor === s.id && usable && url && (");
    expect(m).toMatch(/\{readable && <div className="rounded-xl border[^"]*">\s*\n\s*<div[^>]*>Create new<\/div>/);
    expect(m).toMatch(/\{!readable && \(\s*\n\s*<div className="rounded-lg bg-amber-50/);
    expect(m).toMatch(/Link hidden &mdash; you can&rsquo;t read this document/);
    // Revoke is rendered outside the usable-only block, for any live row
    const revoke = m.slice(m.indexOf("{!dead && (\n"), m.indexOf('title="Revoke"'));
    expect(revoke).toContain("onClick={() => void revoke(s.id)}");
    expect(m).not.toMatch(/value=\{`\$\{baseUrl\}\$\{s\.token\}`\}/);
  });
});

describe("20261066 — document_shares SELECT applies the document-read decision", () => {
  const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
  const m66 = mig("20261066_rp_roundE_share_list_read_decision.sql");
  const m37 = mig("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");
  function between(text: string, from: string, to: string): string {
    const a = text.indexOf(from);
    const b = text.indexOf(to, a + from.length);
    expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
    expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
    return text.slice(a, b);
  }
  const trimmed = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const policy = between(m66, "CREATE POLICY document_shares_org_select ON document_shares FOR SELECT USING (", "COMMENT ON POLICY");

  it("re-creates ONLY the SELECT policy: membership AND (creator OR document readable), inside one transaction", () => {
    expect(m66.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(m66).toMatch(/DROP POLICY IF EXISTS document_shares_org_select ON document_shares;\s*\nCREATE POLICY document_shares_org_select/);
    expect(m66).not.toMatch(/CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER|ALTER TABLE/);
    expect(m66.indexOf("BEGIN;")).toBeLessThan(m66.indexOf("CREATE POLICY"));
    expect(m66.indexOf("COMMIT;")).toBeLessThan(m66.indexOf("── Verification"));
    expect(policy).toMatch(/AND m\.status = 'active'\s*\n\s*\)\s*\n\s*AND \(\s*\n\s*document_shares\.created_by = auth\.uid\(\)\s*\n\s*OR EXISTS \(/);
  });

  it("the read-decision block is byte-carried (modulo indent) from the 20261037 INSERT policy", () => {
    const insert = between(m37, "CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (", ");");
    const liveBlock = trimmed(between(insert, "SELECT 1 FROM documents d", "  )"));
    const nextBlock = trimmed(between(policy, "SELECT 1 FROM documents d", "    )"));
    expect(nextBlock).toEqual(liveBlock);
    expect(liveBlock).toContain("AND d.org_id = document_shares.org_id");
    expect(liveBlock.join(" ")).toContain("node_visible(d.visibility, d.acl_index, d.org_id, d.owner_user_id, d.collection_id, d.library_id)");
    // and the membership term is the INSERT policy's, verbatim
    const liveMember = trimmed(between(insert, "SELECT 1 FROM org_members m", "  )"));
    const nextMember = trimmed(between(policy, "SELECT 1 FROM org_members m", "  )"));
    expect(nextMember).toEqual(liveMember);
  });

  it("ends with ONE result set: probes (check, ok) unioned with aggregate-only inventory (n as text), deparse-safe patterns", () => {
    const tail = m66.slice(m66.indexOf("── Verification"));
    expect(tail.match(/;\s*$/g)).toHaveLength(1);
    expect(tail.match(/\bSELECT '/g)!.length).toBeGreaterThanOrEqual(10);
    expect(tail.match(/UNION ALL/g)!.length).toBe(tail.match(/\bSELECT '/g)!.length - 1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    for (const x of tail.matchAll(/qual LIKE '((?:[^']|'')*)'/g)) {
      expect(x[1], x[1]).not.toMatch(/\w::\w/);
    }
    expect(tail).toMatch(/inventory: live share rows on restricted documents/);
    expect(tail).toMatch(/COUNT\(\*\)/);
    expect(tail).not.toMatch(/SELECT (id|token|uid)\b/);
    // narrowing, not widening: no pre-apply TEMP TABLE is needed and none is claimed
    expect(m66).not.toMatch(/TEMP TABLE/);
    expect(m66).toMatch(/NARROWS: strictly fewer rows are visible/);
  });

  it("the 'only policy' probe counts by cmd alone — a surviving permissive SELECT / FOR ALL policy would OR with the new one", () => {
    const tail = m66.slice(m66.indexOf("── Verification"));
    const probes = tail.split(/\nUNION ALL\n/);
    const exists = probes.find((x) => x.includes("document_shares_org_select exists"))!;
    const only = probes.find((x) => x.includes("ONLY permissive policy admitting SELECT"))!;
    expect(exists).toMatch(/COUNT\(\*\) = 1[\s\S]*cmd = 'SELECT'[\s\S]*policyname = 'document_shares_org_select'/);
    expect(only).toMatch(/COUNT\(\*\) = 1[\s\S]*tablename = 'document_shares'[\s\S]*cmd IN \('SELECT', 'ALL'\)[\s\S]*permissive = 'PERMISSIVE'/);
    expect(only).not.toMatch(/policyname/);
    // the sequence itself leaves exactly one permissive policy admitting SELECT on document_shares
    // (20261022 dropped the 20260623 FOR ALL policy), so the probe is true on a fully-migrated database
    const dir = join(process.cwd(), "supabase", "migrations");
    const live = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => /^\d{8}/.test(x) && x.endsWith(".sql")).sort()) {
      const txt = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      for (const m of txt.matchAll(/DROP POLICY IF EXISTS (\w+) ON document_shares/g)) live.delete(m[1]);
      for (const m of txt.matchAll(/CREATE POLICY (\w+) ON document_shares FOR (\w+)/g)) live.set(m[1], m[2]);
    }
    expect([...live.entries()].filter(([, cmd]) => cmd === "SELECT" || cmd === "ALL")).toEqual([["document_shares_org_select", "SELECT"]]);
  });
});
