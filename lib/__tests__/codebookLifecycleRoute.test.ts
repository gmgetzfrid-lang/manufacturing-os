// intelligence Round G (I-16 CODEBOOK LIFECYCLE) — POST /api/admin/codebook,
// driven end to end against an in-memory PostgREST (vi.hoisted state, a
// Proxy-free chain builder for the service client and the caller's client).
//
//   * Authority: authorizeAdminSurface(req, orgId, "codebook") admits any
//     member; the route also requires adminSurface("codebook").writes,
//     tested against the caller's FULL role collection (a Manager holding
//     DocCtrl additively passes, a Manager alone does not). No role list in
//     the route.
//   * CB-6 preview = apply: the rows the apply writes are exactly the rows
//     the preview returned (same values, compare-and-set on the code the
//     preview read and the filing), through the CALLER's client; a plan that
//     moved since the preview is refused whole (409) and nothing is written;
//     a row that changed in between is counted, never overwritten; the job
//     is bounded per call and audited before and after.
//   * Before 20261178 (42703 on codebook_version) the re-decode still works
//     and reports no version.
//   * CB-5: the rename is the database's function called with the caller's
//     session; the apply carries the preview's counts as p_expected; a
//     missing function (PGRST202) answers needsMigration with today's way.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type PgErr = { code?: string; message: string };

const { st, client } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type PgErr = { code?: string; message: string };
  const st = {
  tables: {} as Record<string, Row[]>,
  actor: null as unknown,
  missingColumns: new Set<string>(),
  readErrors: {} as Record<string, { code?: string; message: string }>,
  insertErrors: {} as Record<string, { code?: string; message: string }>,
  rpc: null as null | ((name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  /** The caller's assets UPDATE: return an error, or "skip" (0 rows), or undefined (apply). */
  updateHook: null as null | ((row: Row, patch: Row) => { code?: string; message: string } | "skip" | undefined),
  writes: [] as Array<{ client: "caller" | "admin"; table: string; patch: Row; filters: Array<[string, unknown]> }>,
  rpcCalls: [] as Array<{ client: "caller" | "admin"; name: string; args: Record<string, unknown> }>,
  callerToken: null as string | null,
};

  function builder(client: "caller" | "admin", table: string) {
    let op: "select" | "update" | "insert" = "select";
    let cols = "*";
    let patch: Row = {};
    let inserted: Row[] = [];
    const filters: Array<[string, (r: Row) => boolean, unknown]> = [];
    let lim: number | null = null;
    const rows = () => (st.tables[table] ??= []);
    const run = (): { data: unknown; error: PgErr | null } => {
      if (op === "insert") {
        if (st.insertErrors[table]) return { data: null, error: st.insertErrors[table] };
        rows().push(...inserted);
        return { data: inserted, error: null };
      }
      const hit = rows().filter((r) => filters.every(([, f]) => f(r)));
      if (op === "update") {
        st.writes.push({ client, table, patch, filters: filters.map(([k, , v]) => [k, v]) });
        const out: Row[] = [];
        for (const r of hit) {
          const h = st.updateHook?.(r, patch);
          if (h === "skip") continue;
          if (h) return { data: null, error: h };
          Object.assign(r, patch);
          out.push({ id: r.id });
        }
        return { data: out, error: null };
      }
      if (st.readErrors[table]) return { data: null, error: st.readErrors[table] };
      const missing = cols.split(",").map((c) => c.trim()).find((c) => st.missingColumns.has(`${table}.${c}`));
      if (missing) return { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
      const sorted = [...hit].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const picked = cols.trim() === "*" ? sorted
        : sorted.map((r) => Object.fromEntries(cols.split(",").map((c) => c.trim()).filter((c) => c in r).map((c) => [c, r[c]])));
      return { data: lim === null ? picked : picked.slice(0, lim), error: null };
    };
    const self: Record<string, unknown> = {
      select(c?: string) { if (op === "select") cols = c ?? "*"; return self; },
      update(p: Row) { op = "update"; patch = p; return self; },
      insert(r: Row | Row[]) { op = "insert"; inserted = Array.isArray(r) ? r : [r]; return self; },
      eq(k: string, v: unknown) { filters.push([k, (r) => r[k] === v, v]); return self; },
      gt(k: string, v: unknown) { filters.push([`${k}>`, (r) => String(r[k]) > String(v), v]); return self; },
      in(k: string, v: unknown[]) { filters.push([`${k} in`, (r) => v.includes(r[k]), v]); return self; },
      order() { return self; },
      limit(n: number) { lim = n; return self; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) { try { resolve(run()); } catch (e) { reject?.(e); } },
    };
    return self;
  }
  const client = (kind: "caller" | "admin") => ({
    from: (t: string) => builder(kind, t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ client: kind, name, args });
      return st.rpc ? st.rpc(name, args) : { data: null, error: { code: "PGRST202", message: "Could not find the function public.rename_codebook_code" } };
    },
  });
  return { st, client };
});

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: client("admin") }));
vi.mock("@/lib/adminGate", () => ({ authorizeAdminSurface: vi.fn(async () => st.actor) }));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: (req: Request) => {
    st.callerToken = req.headers.get("authorization");
    return client("caller");
  },
}));

import { POST, REDECODE_WRITE_BUDGET, RENAME_NOT_APPLIED } from "@/app/api/admin/codebook/route";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { redecodeDigest } from "@/lib/assetCategorize";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const call = (body: Record<string, unknown>) => POST(new NextRequest("http://x/api/admin/codebook", {
  method: "POST", headers: { authorization: "Bearer caller-jwt", "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG, ...body }),
}));
const actorWith = (roles: string[], role = roles[0]) => ({ userId: "u-1", email: "c@x", orgId: ORG, role, roles, admittedRole: role, admin: {}, surface: {} });

function seed() {
  st.tables = {
    codebook_entries: [
      { id: "e-u20", org_id: ORG, kind: "unit", code: "20", label: "Crude", meta: {}, sort: 0, origin: "manual" },
      { id: "e-u25", org_id: ORG, kind: "unit", code: "25", label: "DHT", meta: {}, sort: 1, origin: "manual" },
      { id: "e-t30", org_id: ORG, kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" },
    ],
    codebook_config: [{ org_id: ORG, iterable_rule: { mirrorsTag: true, padTo: 3 }, drawing_number: {}, legend_doc_ids: [], codebook_version: 5 }],
    assets: [
      { id: "a1", org_id: ORG, tag: "E-22", unit_code: "20", code: "2030.22", archived: false, codebook_version: 3 },
      { id: "a2", org_id: ORG, tag: "E-23", unit_code: "20", code: "2030.23", archived: false, codebook_version: 5 },
      { id: "a3", org_id: ORG, tag: "E-24", unit_code: "25", code: "2030.24", archived: false, codebook_version: 5 },  // names another unit
      { id: "a4", org_id: ORG, tag: "E-25", unit_code: "20", code: null, archived: false, codebook_version: null },     // blank: not a re-decode
      { id: "a5", org_id: ORG, tag: "E-26", unit_code: "20", code: "2030.26", archived: false, codebook_version: 5 },
      { id: "a9", org_id: ORG, tag: "E-099", unit_code: null, code: "2030.026", archived: true, codebook_version: 2 }, // archived holder of a5's derived code
      { id: "x1", org_id: "other-org", tag: "E-22", unit_code: "20", code: "2030.22", archived: false, codebook_version: 1 },
    ],
    audit_logs: [],
  };
}

beforeEach(() => {
  seed();
  st.actor = actorWith(["Admin"]);
  st.missingColumns = new Set();
  st.readErrors = {};
  st.insertErrors = {};
  st.rpc = null;
  st.updateHook = null;
  st.writes = [];
  st.rpcCalls = [];
  st.callerToken = null;
  vi.mocked(authorizeAdminSurface).mockClear();
});

describe("authority — the codebook surface, then its writes set, by the FULL role collection", () => {
  it("asks the one admin gate for the codebook surface, and passes its refusal through", async () => {
    st.actor = { error: "Not a member of this org", status: 403 };
    const res = await call({ action: "redecode-preview" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a member of this org");
    expect(vi.mocked(authorizeAdminSurface).mock.calls[0][1]).toBe(ORG);
    expect(vi.mocked(authorizeAdminSurface).mock.calls[0][2]).toBe("codebook");
  });
  it("a member outside the writes set is refused (a Manager alone); nothing is read or written", async () => {
    st.actor = actorWith(["Manager"]);
    for (const action of ["redecode-preview", "redecode-apply", "rename-preview", "rename"]) {
      const res = await call({ action, token: "t", kind: "unit", from: "20", to: "21" });
      expect(res.status, action).toBe(403);
    }
    expect(st.writes).toEqual([]);
    expect(st.rpcCalls).toEqual([]);
  });
  it("additive roles count: a Manager holding DocCtrl, or a Viewer headline over Admin, is admitted", async () => {
    for (const roles of [["Manager", "DocCtrl"], ["Viewer", "Admin"]]) {
      st.actor = actorWith(roles);
      expect((await call({ action: "redecode-preview" })).status, roles.join("+")).toBe(200);
    }
  });
  it("no role list in the route: it reads adminSurface(\"codebook\").writes (DEC-35)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/admin/codebook/route.ts"), "utf8");
    expect(src).toContain('await authorizeAdminSurface(req, orgId, "codebook")');
    expect(src).toContain('const writes = adminSurface("codebook")?.writes ?? [];');
    expect(src).toContain("memberHoldsAny({ roles: actor.roles }, writes)");
    expect(src).not.toMatch(/"Admin"|"DocCtrl"|'Admin'|'DocCtrl'/);
    expect(src).not.toMatch(/const [A-Z_]*ROLES = /);
  });
});

describe("CB-6 — the server re-decode: preview = apply", () => {
  it("preview: the rows, the skipped, the token, the codebook version and how many codes predate it — nothing written", async () => {
    const res = await call({ action: "redecode-preview" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([
      { assetId: "a1", tag: "E-22", unitCode: "20", from: "2030.22", to: "2030.022", codebookVersion: 3 },
      { assetId: "a2", tag: "E-23", unitCode: "20", from: "2030.23", to: "2030.023", codebookVersion: 5 },
    ]);
    expect(body.skipped).toEqual([
      { assetId: "a3", tag: "E-24", from: "2030.24", to: "2530.024", reason: "names_other_unit" },
      { assetId: "a5", tag: "E-26", from: "2030.26", to: "2030.026", reason: "taken" },
    ]);
    expect(body.token).toBe(createHash("sha256").update(redecodeDigest(body.rows)).digest("hex"));
    expect(body.codebookVersion).toBe(5);
    expect(body.writtenUnderEarlier).toBe(1);
    expect(st.writes).toEqual([]);
  });
  it("apply writes EXACTLY the previewed rows — same values, compare-and-set on the code and filing read, through the caller's session", async () => {
    const preview = await (await call({ action: "redecode-preview" })).json();
    const res = await call({ action: "redecode-apply", token: preview.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 2, changed: 0, taken: 0, refused: 0, firstError: null, remaining: 0 });
    const assetWrites = st.writes.filter((w) => w.table === "assets");
    expect(assetWrites.every((w) => w.client === "caller")).toBe(true);
    expect(st.callerToken).toBe("Bearer caller-jwt");
    // the written set IS the preview's rows
    expect(assetWrites.map((w) => ({
      assetId: w.filters.find(([k]) => k === "id")![1], from: w.filters.find(([k]) => k === "code")![1],
      unitCode: w.filters.find(([k]) => k === "unit_code")![1], to: w.patch.code,
    }))).toEqual(preview.rows.map((r: Row) => ({ assetId: r.assetId, from: r.from, unitCode: r.unitCode, to: r.to })));
    for (const w of assetWrites) expect(w.filters.find(([k]) => k === "org_id")![1]).toBe(ORG);
    expect(st.tables.assets.find((a) => a.id === "a1")!.code).toBe("2030.022");
    expect(st.tables.assets.find((a) => a.id === "x1")!.code).toBe("2030.22"); // another org: untouched
    expect(st.tables.assets.find((a) => a.id === "a3")!.code).toBe("2030.24"); // a person decides
    // audited before and after, counts only
    expect(st.tables.audit_logs.map((r) => [r.action, (r.details as Row).phase])).toEqual([["CODEBOOK_REDECODE", "started"], ["CODEBOOK_REDECODE", "finished"]]);
    expect(st.tables.audit_logs[0]).toMatchObject({ org_id: ORG, user_id: "u-1", details: { planned: 2, thisCall: 2, skipped: 2, codebookVersion: 5 } });
    expect(st.tables.audit_logs[1]).toMatchObject({ details: { written: 2, changed: 0, taken: 0, refused: 0, remaining: 0 } });
    // a second preview plans nothing: idempotent
    expect((await (await call({ action: "redecode-preview" })).json()).rows).toEqual([]);
  });
  it("a plan that moved since the preview is refused whole (409, changed) and nothing is written", async () => {
    const preview = await (await call({ action: "redecode-preview" })).json();
    st.tables.assets.find((a) => a.id === "a2")!.code = "2030.0230";
    const res = await call({ action: "redecode-apply", token: preview.token });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true, error: expect.stringMatching(/changed since the preview, so nothing was written/) });
    expect(st.writes).toEqual([]);
    expect(st.tables.audit_logs).toEqual([]);
  });
  it("a row that changes between the plan and its write is counted and left; a code taken meanwhile is counted; a refusal says why", async () => {
    const preview = await (await call({ action: "redecode-preview" })).json();
    st.updateHook = (row) => (row.id === "a1" ? "skip" : { code: "23505", message: 'duplicate key value violates unique constraint "assets_org_code_unique"' });
    expect(await (await call({ action: "redecode-apply", token: preview.token })).json())
      .toEqual({ written: 0, changed: 1, taken: 1, refused: 0, firstError: null, remaining: 0 });
    seed();
    st.updateHook = () => ({ code: "42501", message: "Only Admin, Document Control, Manager or Supervisor can edit the asset registry." });
    expect(await (await call({ action: "redecode-apply", token: preview.token })).json())
      .toMatchObject({ written: 0, refused: 2, firstError: "Only Admin, Document Control, Manager or Supervisor can edit the asset registry." });
  });
  it("no token, no apply; an audit record that cannot be written writes nothing", async () => {
    expect((await call({ action: "redecode-apply" })).status).toBe(400);
    const preview = await (await call({ action: "redecode-preview" })).json();
    st.insertErrors.audit_logs = { message: "audit down" };
    const res = await call({ action: "redecode-apply", token: preview.token });
    expect(res.status).toBe(500);
    expect(st.writes).toEqual([]);
  });
  it("bounded per call: at most REDECODE_WRITE_BUDGET rows, in preview order; the rest is `remaining`", async () => {
    st.tables.codebook_config[0].iterable_rule = { mirrorsTag: true, padTo: 4 }; // every one of the codes re-derives
    st.tables.assets = Array.from({ length: REDECODE_WRITE_BUDGET + 5 }, (_, i) => ({
      id: `b${String(i).padStart(4, "0")}`, org_id: ORG, tag: `E-${i + 1}`, unit_code: "20", code: `2030.${i + 1}`, archived: false, codebook_version: 5,
    }));
    const preview = await (await call({ action: "redecode-preview" })).json();
    expect(preview.rows.length).toBe(REDECODE_WRITE_BUDGET + 5);
    const out = await (await call({ action: "redecode-apply", token: preview.token })).json();
    expect(out).toMatchObject({ written: REDECODE_WRITE_BUDGET, remaining: 5 });
    expect(st.writes.filter((w) => w.table === "assets").map((w) => w.filters.find(([k]) => k === "id")![1]))
      .toEqual(preview.rows.slice(0, REDECODE_WRITE_BUDGET).map((r: Row) => r.assetId));
  });
  it("before 20261178 (no codebook_version): the re-decode still works and reports no version", async () => {
    st.missingColumns = new Set(["assets.codebook_version"]);
    delete st.tables.codebook_config[0].codebook_version;
    const body = await (await call({ action: "redecode-preview" })).json();
    expect(body.rows.map((r: Row) => [r.assetId, r.to, r.codebookVersion])).toEqual([["a1", "2030.022", null], ["a2", "2030.023", null]]);
    expect(body.codebookVersion).toBeNull();
    expect(body.writtenUnderEarlier).toBeNull();
  });
  it("an unreadable codebook plans nothing — never an empty plan that reads as \"nothing to re-decode\"", async () => {
    st.readErrors.codebook_entries = { message: "boom" };
    const res = await call({ action: "redecode-preview" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/The Site Codebook could not be read \(boom\) — nothing was planned/);
  });
});

describe("CB-5 — the rename: the database's one transaction, with the caller's session", () => {
  const preview = { kind: "unit", from: "21", to: "20", label: "Crude", assetsFiled: 4, assetsCoded: 4, flows: 2, unitMappings: 1, adopted: 1, adoptedFlows: 0, blockers: [] };
  it("before 20261178: 409 needsMigration, with today's way said", async () => {
    const res = await call({ action: "rename-preview", kind: "unit", from: "21", to: "20" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RENAME_NOT_APPLIED, needsMigration: true });
    expect(RENAME_NOT_APPLIED).toMatch(/add the new code, refile its equipment under Operating areas, then remove the old code/);
  });
  it("the preview is a dry run with no expected counts; the apply carries the preview's counts only", async () => {
    st.rpc = () => ({ data: preview, error: null });
    expect(await (await call({ action: "rename-preview", kind: "unit", from: "21", to: "20" })).json()).toEqual(preview);
    expect(st.rpcCalls[0]).toEqual({ client: "caller", name: "rename_codebook_code", args: { p_org_id: ORG, p_kind: "unit", p_old_code: "21", p_new_code: "20", p_dry_run: true, p_expected: null } });
    expect((await call({ action: "rename", kind: "unit", from: "21", to: "20" })).status).toBe(400); // no preview, no apply
    await call({ action: "rename", kind: "unit", from: "21", to: "20", expected: { ...preview, extra: "ignored" } });
    expect(st.rpcCalls[1].args).toEqual({ p_org_id: ORG, p_kind: "unit", p_old_code: "21", p_new_code: "20", p_dry_run: false, p_expected: { assetsFiled: 4, assetsCoded: 4, flows: 2, unitMappings: 1, adopted: 1, adoptedFlows: 0 } });
    expect(st.rpcCalls.every((c) => c.client === "caller")).toBe(true);
  });
  it("the database's refusals are said, with the right status", async () => {
    const cases: Array<[PgErr, number, RegExp, boolean?]> = [
      [{ code: "42501", message: "rename_codebook_code: only Admin or Document Control can rename a Site Codebook code" }, 403, /^only Admin or Document Control/],
      [{ code: "40001", message: "rename_codebook_code: what this rename touches changed since the preview — preview it again" }, 409, /^what this rename touches changed/, true],
      [{ code: "23514", message: "rename_codebook_code: 1 renamed site code(s) are already carried by another asset — one site code is one asset; resolve them first" }, 409, /^1 renamed site code\(s\)/],
      [{ code: "23505", message: "rename_codebook_code: unit 25 already exists — a code is renamed onto a free code only" }, 409, /^unit 25 already exists/],
      [{ code: "23503", message: "codebook_entries_in_use: unit 21 is still referenced by 1 asset(s) and 0 process flow(s)" }, 409, /^Refused — unit 21 is still referenced by 1 asset\(s\)/],
      [{ code: "XX000", message: "boom" }, 500, /^The rename did not run: boom/],
    ];
    for (const [err, status, msg, changed] of cases) {
      st.rpc = () => ({ data: null, error: err });
      const res = await call({ action: "rename", kind: "unit", from: "21", to: "20", expected: preview });
      expect(res.status, err.code).toBe(status);
      const body = await res.json();
      expect(body.error, err.code).toMatch(msg);
      if (changed) expect(body.changed).toBe(true);
    }
  });
  it("a bad request is refused before the database is asked (drawing types are not renamed here)", async () => {
    expect((await call({ action: "rename-preview", kind: "drawing_type", from: "02", to: "03" })).status).toBe(400);
    expect((await call({ action: "rename-preview", kind: "unit", from: "", to: "20" })).status).toBe(400);
    expect((await call({ action: "nope" })).status).toBe(400);
    expect(st.rpcCalls).toEqual([]);
  });
});
