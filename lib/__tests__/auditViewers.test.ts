// admin-and-org Round G — package P7: the audit viewers.
//
// ALOG-11: lib/auditActions.ts is the registry both viewers read — a census
//   holds it to every action the app writes, so a new action is filterable
//   the day it ships; the deletes KPI counts a stated list.
// ALOG-6: the export pages through every row the chosen filters select
//   (server-side paging), includes metadata and actor_kind, states its own
//   bounds inside the file, and is audited before the file is handed over.
// drafting-flow EVID-12: both viewers pair a TICKET_<ACTION> attempt row with
//   the _NOT_APPLIED / _HOLDS_NOT_RELEASED row that names it.
// ALOG-7: the viewer says whose word a row's identity is (actor_kind).
// ALOG-5 (residual): /activity states its rule.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_ACTIONS, AUDIT_ACTION_FAMILIES, AUDIT_RESOURCE_TYPES, DESTRUCTIVE_AUDIT_ACTIONS, auditActionDef,
  auditActionFilterOptions, auditActionFilterQuery, pairTicketAttempts, isDestructiveAuditAction, auditActorNote,
} from "@/lib/auditActions";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);

/** Every action name a writer spells: `action: "X"` in app/lib/components/hooks
 *  (the file must touch audit), the helpers' `type:` unions in lib/audit.ts,
 *  and the first VALUES literal of every SQL INSERT INTO audit_logs (action). */
function writtenActions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of ["app", "lib", "components", "hooks"].flatMap(walk)) {
    if (p === join("lib", "auditActions.ts")) continue;
    const s = src(p);
    if (!/audit/i.test(s)) continue;
    for (const m of s.matchAll(/\baction\s*:\s*["']([A-Z][A-Z0-9_]+)["']/g)) out.set(m[1], p);
  }
  const audit = src("lib/audit.ts");
  for (const m of audit.matchAll(/\|?\s*"([A-Z][A-Z0-9_]+)"/g)) out.set(m[1], "lib/audit.ts");
  const dir = join(root, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d{8}.*\.sql$/.test(x))) {
    const s = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of s.matchAll(/INSERT INTO (?:public\.)?audit_logs\s*\(\s*action\b[^)]*\)\s*VALUES\s*\(\s*'([A-Z][A-Z0-9_]+)'/gi)) out.set(m[1], f);
    for (const m of s.matchAll(/THEN '([A-Z][A-Z0-9_]+)'/g)) if (/SKILL_|_CREATED|_UPDATED|_DELETED/.test(m[1]) && /audit_logs/.test(s)) out.set(m[1], f);
  }
  out.delete("ALOG7_SELF_TEST"); // 20261201's rolled-back self-test row, never kept
  return out;
}

describe("ALOG-11 — one registry the viewers read", () => {
  it("every action a writer spells is registered (or in a family), so it is filterable the day it ships", () => {
    expect(writtenActions().size).toBeGreaterThan(150); // the census walks the writers (not vacuous)
    const missing = [...writtenActions()].filter(([a]) => !auditActionDef(a)).map(([a, where]) => `${a} (${where})`);
    expect(missing).toEqual([]);
  });

  it("every icon / verb the two viewers carry is a registered action (no second vocabulary drifts)", () => {
    for (const page of ["app/(protected)/admin/audit/page.tsx", "app/(protected)/activity/page.tsx"]) {
      const s = src(page);
      const map = /const (ACTION_STYLE|ACTION_VERBS)[^=]*=\s*\{([\s\S]*?)\n\};/.exec(s);
      expect(map, page).not.toBeNull();
      for (const m of map![2].matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)) expect(auditActionDef(m[1]), `${page}: ${m[1]}`).not.toBeNull();
    }
  });

  it("the actions the finding named as unreachable are filterable now", () => {
    const values = new Set(auditActionFilterOptions().map((o) => o.value));
    for (const a of ["CAPABILITY_POLICY_CHANGED", "NODE_ACL_CHANGED", "ACCESS_RECERTIFIED", "DATA_PURGE", "RESTORE_BEGIN",
      "ESIGNATURE_CAPTURED", "FOLDER_DELETED", "STORAGE_ORPHANS_PURGED", "DATA_EXPORT", "DATA_EXPORT_FILES",
      "DATA_EXPORT_UNDELIVERED", "BRANDING_LOGO_UPLOAD", "PLATFORM_STORAGE_LIMITS_CHANGED", "STRIPE_CHECKOUT_CREATED",
      "STRIPE_INVOICE_PAYMENT_SUCCEEDED", "ARCHIVE_SETTINGS_CHANGED", "STORAGE_QUOTA_CHANGED"]) {
      expect(values.has(a), a).toBe(true);
    }
    // P3 / P4 / P6 hand-offs: the registry names their actions (99-fix-sequencing, Integrator notes).
    expect(auditActionDef("DATA_EXPORT_UNDELIVERED")!.category).toBe("export");
    expect(auditActionDef("STRIPE_CUSTOMER_SUBSCRIPTION_DELETED")!.category).toBe("billing");
    // An action seen in the rows that nothing registers is still offered.
    expect(auditActionFilterOptions(["SOMETHING_NEW"]).find((o) => o.value === "SOMETHING_NEW")?.group).toMatch(/not in the registry/);
  });

  it("the resource filter offers every resource_type a writer uses", () => {
    const types = new Set(AUDIT_RESOURCE_TYPES.map((t) => t.value));
    for (const p of ["app", "lib", "components", "hooks"].flatMap(walk)) {
      const s = src(p);
      if (!/audit/i.test(s) || p === join("lib", "auditActions.ts")) continue;
      for (const m of s.matchAll(/\bresource_?[tT]ype\s*:\s*["']([a-z_]+)["']/g)) expect(types.has(m[1]), `${p}: ${m[1]}`).toBe(true);
    }
  });

  it("the destructive KPI is a stated list: real destruction counts; a request, a restore and a cancel do not", () => {
    for (const a of ["DATA_PURGE", "STORAGE_ORPHANS_PURGED", "SUPERSEDE_DOC", "TRANSMITTAL_VOIDED", "FOLDER_DELETED", "FORCE_RELEASE"]) {
      expect(isDestructiveAuditAction(a), a).toBe(true);
    }
    for (const a of ["DELETION_REQUESTED", "TICKET_ARCHIVE_RESTORE", "ARCHIVE_PRODUCE_CANCELED", "VIEW"]) {
      expect(isDestructiveAuditAction(a), a).toBe(false);
    }
    for (const a of DESTRUCTIVE_AUDIT_ACTIONS) expect(auditActionDef(a), a).not.toBeNull();
    // The page counts the list, never a regex.
    const page = src("app/(protected)/admin/audit/page.tsx");
    expect(page).not.toMatch(/DELET\|ARCHIVE\|REVERS\|FORCE/);
    expect(page).toMatch(/isDestructiveAuditAction\(/);
  });

  it("a ticket action filter brings its EVID-12 follow-ups; a family filters by prefix", () => {
    expect(auditActionFilterQuery("TICKET_CLOSE")).toEqual({ kind: "in", actions: ["TICKET_CLOSE", "TICKET_CLOSE_NOT_APPLIED", "TICKET_CLOSE_HOLDS_NOT_RELEASED"] });
    expect(auditActionFilterQuery("family:TICKET_")).toEqual({ kind: "family", like: "TICKET_%" });
    expect(auditActionFilterQuery("DATA_PURGE")).toEqual({ kind: "in", actions: ["DATA_PURGE"] });
    expect(auditActionFilterQuery("ALL")).toBeNull();
    expect(AUDIT_ACTION_FAMILIES.some((f) => f.prefix === "TICKET_")).toBe(true);
    expect(new Set(AUDIT_ACTIONS.map((d) => d.action)).size).toBe(AUDIT_ACTIONS.length);
  });
});

describe("drafting-flow EVID-12 — the viewers pair a ticket attempt with the row that names it", () => {
  const rows = [
    { id: "n1", action: "TICKET_CLOSE_NOT_APPLIED", details: { attempt: "a1", reason: "conflict" } },
    { id: "a1", action: "TICKET_CLOSE", details: { recordedBeforeApply: true, from: "OPEN", to: "CLOSED" } },
    { id: "h2", action: "TICKET_CLOSE_HOLDS_NOT_RELEASED", details: { attempt: "a2", holdIds: ["h"] } },
    { id: "a2", action: "TICKET_CLOSE", details: { recordedBeforeApply: true } },
    { id: "a3", action: "TICKET_APPROVE_DRAFT_IFC", details: { recordedBeforeApply: true } },
    { id: "old", action: "TICKET_CLOSE", details: { from: "OPEN", to: "CLOSED" } }, // before DF-P1: no marker
  ];
  it("an attempt named by a _NOT_APPLIED row did not land; one named by _HOLDS_NOT_RELEASED landed without releasing holds; the rest landed", () => {
    const { attempts, followUps } = pairTicketAttempts(rows);
    expect(attempts.get("a1")).toEqual({ outcome: "not_applied", followUpId: "n1" });
    expect(attempts.get("a2")).toEqual({ outcome: "holds_not_released", followUpId: "h2" });
    expect(attempts.get("a3")).toEqual({ outcome: "applied", followUpId: null });
    expect(attempts.has("old")).toBe(false);
    expect(followUps).toEqual(new Map([["n1", "a1"], ["h2", "a2"]]));
  });
  it("both viewers use the pairing", () => {
    for (const page of ["app/(protected)/admin/audit/page.tsx", "app/(protected)/activity/page.tsx"]) {
      expect(src(page), page).toMatch(/pairTicketAttempts\(/);
    }
  });
});

describe("ALOG-7 — the viewer says whose word a row's identity is", () => {
  it("names each actor_kind, and a row written before 20261201 as the writer's word", () => {
    expect(auditActorNote("member")).toMatch(/resolved by the database/);
    expect(auditActorNote("server")).toMatch(/server/);
    expect(auditActorNote("system")).toMatch(/no person/);
    expect(auditActorNote(undefined)).toMatch(/as sent by the writer/);
    expect(src("app/(protected)/admin/audit/page.tsx")).toMatch(/auditActorNote\(row\.actorKind\)/);
  });
});

// ── ALOG-6: the export ─────────────────────────────────────────────────────
import {
  applyAuditFilters, buildAuditCsv, fetchAuditRowsForExport, filterByLibrary, userEmailPattern, rangeStartIso,
  AUDIT_EXPORT_ROW_CEILING, type AuditExportRow,
} from "@/lib/auditLogExport";

/** A PostgREST stand-in for audit_logs that records each call and honours the
 *  keyset reads the export makes: lte / or(after-cursor) / is / lt / order /
 *  limit. Like PostgreSQL, rows that tie on every ORDER BY column come back
 *  in a DIFFERENT order on each query (the fake shuffles ties per query), so
 *  only a total order — "timestamp" DESC, id DESC — pages without loss. */
function pager(n: number, failAt?: number, opts: { tieEvery?: number; undated?: number; seed?: number } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const tieEvery = opts.tieEvery ?? 1;
  const iso = (i: number) => new Date(Date.UTC(2026, 9, 1) - Math.floor(i / tieEvery) * 1000).toISOString();
  const all: Array<Record<string, unknown>> = Array.from({ length: n }, (_, i) => ({
    id: `r${String(i).padStart(6, "0")}`, action: "VIEW", resource_type: "document", resource_id: `d${i % 3}`, org_id: "o1", user_id: "u1",
    user_email: "a@b.c", user_role: "Drafter", actor_kind: i % 2 ? "member" : null, details: { i }, metadata: i === 0 ? { asserted: { user_role: "Admin" } } : null,
    timestamp: iso(i),
  }));
  for (let j = 0; j < (opts.undated ?? 0); j++) all.push({ ...all[0], id: `u${String(j).padStart(6, "0")}`, details: { undated: j }, metadata: null, timestamp: null });
  let seed = opts.seed ?? 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let pages = 0;
  const start = () => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = [];
    const orderBy: string[] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["gte", "eq", "in", "like", "ilike"]) b[m] = (...a: unknown[]) => { calls.push([m, a]); return b; };
    b.lte = (k: string, v: string) => { calls.push(["lte", [k, v]]); preds.push((r) => r[k] != null && String(r[k]) <= v); return b; };
    b.lt = (k: string, v: string) => { calls.push(["lt", [k, v]]); preds.push((r) => String(r[k]) < v); return b; };
    b.is = (k: string, v: null) => { calls.push(["is", [k, v]]); preds.push((r) => (r[k] ?? null) === v); return b; };
    b.or = (f: string) => {
      calls.push(["or", [f]]);
      const m = /^timestamp\.lt\."([^"]+)",and\(timestamp\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(f);
      if (!m || m[1] !== m[2]) throw new Error(`unexpected or filter ${f}`);
      preds.push((r) => r.timestamp != null && (String(r.timestamp) < m[1] || (r.timestamp === m[1] && String(r.id) < m[3])));
      return b;
    };
    b.order = (k: string, o: { ascending: boolean }) => { calls.push(["order", [k, o]]); orderBy.push(k); return b; };
    b.limit = (lim: number) => {
      calls.push(["limit", [lim]]);
      pages++;
      if (failAt !== undefined && pages === failAt) return Promise.resolve({ data: null, error: { message: "timeout" } });
      const keyed = all.filter((r) => preds.every((p) => p(r))).map((r) => ({ r, tie: rand() }));
      keyed.sort((x, y) => {
        for (const k of orderBy) {
          const a = x.r[k] == null ? "" : String(x.r[k]); const c = y.r[k] == null ? "" : String(y.r[k]);
          if (a !== c) return a < c ? 1 : -1; // DESC
        }
        return x.tie - y.tie; // ties: no stable order across queries
      });
      return Promise.resolve({ data: keyed.slice(0, lim).map((k) => k.r), error: null });
    };
    return b as never;
  };
  return { start, calls, pages: () => pages, all };
}
const F = { range: "all" as const, action: "ALL", resource: "ALL" };

describe("ALOG-6 — the export holds every row the filters select, says its bounds, and is audited", () => {
  it("pages on the server until the rows run out: 2,345 rows in three keyset pages, all in the file", async () => {
    const p = pager(2345);
    const got = await fetchAuditRowsForExport(p.start, F, Date.now());
    expect(got).toMatchObject({ ok: true, complete: true });
    if (got.ok) expect(got.rows).toHaveLength(2345);
    // three dated pages of up to 1000, then the (empty) undated pass of "all time"
    expect(p.calls.filter(([m]) => m === "limit").map(([, a]) => a)).toEqual([[1000], [1000], [1000], [1000]]);
    expect(p.calls.filter(([m]) => m === "order").slice(0, 2)).toEqual([["order", ["timestamp", { ascending: false }]], ["order", ["id", { ascending: false }]]]);
  });

  it("P7 review: tied timestamps across page boundaries — no row missing, none repeated (ties come back in a new order on every query)", async () => {
    // 2,500 rows, 25 to a timestamp (a chunked ledger write, one transaction's rows); pages of 40 cut through tie groups.
    for (const seed of [1, 2, 3]) {
      const p = pager(2500, undefined, { tieEvery: 25, seed });
      const got = await fetchAuditRowsForExport(p.start, F, Date.UTC(2026, 9, 2), { page: 40 });
      expect(got).toMatchObject({ ok: true, complete: true });
      const ids = (got as { rows: AuditExportRow[] }).rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids)).toEqual(new Set(p.all.map((r) => String(r.id))));
      // newest first, then id DESC inside a timestamp
      const sorted = [...(got as { rows: AuditExportRow[] }).rows].sort((x, y) => (x.timestamp === y.timestamp ? (x.id < y.id ? 1 : -1) : x.timestamp < y.timestamp ? 1 : -1));
      expect(ids).toEqual(sorted.map((r) => r.id));
    }
  });

  it("P7 review: the export is a snapshot — a row written after it began (dated later) is not in it, and nothing shifts or repeats", async () => {
    const p = pager(150);
    const startMs = Date.UTC(2026, 9, 2);
    let injected = false;
    const start = () => {
      if (p.pages() === 1 && !injected) {
        injected = true;
        p.all.unshift({ ...p.all[0], id: "zz-late", timestamp: new Date(startMs + 5_000).toISOString() });
      }
      return p.start();
    };
    const got = await fetchAuditRowsForExport(start as never, F, startMs, { page: 50 });
    const ids = (got as { rows: AuditExportRow[] }).rows.map((r) => r.id);
    expect(injected).toBe(true);
    expect(ids).toHaveLength(150);
    expect(ids).not.toContain("zz-late");
    expect(new Set(ids).size).toBe(150);
    expect(p.calls).toEqual(expect.arrayContaining([["lte", ["timestamp", new Date(startMs).toISOString()]]]));
  });

  it("the next page starts strictly after the last row read (keyset, never an offset)", async () => {
    const p = pager(120, undefined, { tieEvery: 10 });
    await fetchAuditRowsForExport(p.start, F, Date.UTC(2026, 9, 2), { page: 50 });
    const ors = p.calls.filter(([m]) => m === "or").map(([, a]) => (a as string[])[0]);
    expect(ors).toHaveLength(2);
    expect(ors[0]).toMatch(/^timestamp\.lt\."[^"]+",and\(timestamp\.eq\."[^"]+",id\.lt\."r\d{6}"\)$/);
    expect(p.calls.some(([m]) => m === "range")).toBe(false);
  });

  it("all time: rows with no timestamp follow, by id — counted and in the file; a date range leaves them out as the screen does", async () => {
    const p = pager(30, undefined, { undated: 3 });
    const got = await fetchAuditRowsForExport(p.start, F, Date.UTC(2026, 9, 2), { page: 10 });
    const rows = (got as { rows: AuditExportRow[] }).rows;
    expect(rows).toHaveLength(33);
    expect(rows.slice(30).map((r) => r.id)).toEqual(["u000002", "u000001", "u000000"]);
    expect(rows[32].timestamp).toBe("");
    expect(buildAuditCsv(rows.slice(32), new Map(), { orgId: "o1", filters: F, exportedAtIso: "x", rows: 1, complete: true, ceiling: 50_000 })).toContain("(no timestamp)");
    const ranged = pager(30, undefined, { undated: 3 });
    const got7 = await fetchAuditRowsForExport(ranged.start, { ...F, range: "30d" }, Date.UTC(2026, 9, 2), { page: 10 });
    expect((got7 as { rows: AuditExportRow[] }).rows).toHaveLength(30);
    expect(ranged.calls.some(([m]) => m === "is")).toBe(false);
  });
  it("stops at the ceiling and says it is not complete", async () => {
    const p = pager(30);
    const got = await fetchAuditRowsForExport(p.start, F, Date.now(), { ceiling: 25, page: 10 });
    expect(got).toMatchObject({ ok: true, complete: false });
    if (got.ok) expect(got.rows).toHaveLength(25);
    expect(AUDIT_EXPORT_ROW_CEILING).toBe(50_000);
  });
  it("exactly the ceiling is complete", async () => {
    const got = await fetchAuditRowsForExport(pager(20).start, F, Date.now(), { ceiling: 20, page: 10 });
    expect(got).toMatchObject({ ok: true, complete: true });
  });
  it("a failed page stops the export with the error — never a partial file presented as whole", async () => {
    expect(await fetchAuditRowsForExport(pager(2500, 2).start, F, Date.now())).toEqual({ ok: false, error: "timeout" });
  });
  it("applies the same filters as the page, and the user filter on the server (wildcards escaped)", async () => {
    const p = pager(1);
    await fetchAuditRowsForExport(p.start, { range: "7d", action: "TICKET_CLOSE", resource: "ticket", userQuery: "a_b%" }, Date.UTC(2026, 9, 13));
    expect(p.calls).toEqual(expect.arrayContaining([
      ["gte", ["timestamp", rangeStartIso("7d", Date.UTC(2026, 9, 13))]],
      ["in", ["action", ["TICKET_CLOSE", "TICKET_CLOSE_NOT_APPLIED", "TICKET_CLOSE_HOLDS_NOT_RELEASED"]]],
      ["eq", ["resource_type", "ticket"]],
      ["ilike", ["user_email", "%a\\_b\\%%"]],
    ]));
    expect(userEmailPattern("  ")).toBeNull();
    const fam = pager(1);
    applyAuditFilters(fam.start() as never, { range: "all", action: "family:TICKET_", resource: "ALL" }, 0);
    expect(fam.calls).toEqual([["like", ["action", "TICKET_%"]]]);
  });
  it("the file opens with its bounds and carries User ID, Actor kind and Metadata JSON", async () => {
    const got = await fetchAuditRowsForExport(pager(2).start, F, Date.now());
    const rows = (got as { rows: AuditExportRow[] }).rows;
    const csv = buildAuditCsv(rows, new Map([["d0", { documentNumber: "P-101", title: "P&ID" }]]), {
      orgId: "o1", filters: { ...F, userQuery: "" }, exportedAtIso: "2026-10-13T00:00:00.000Z", rows: 2, complete: true, ceiling: 50_000,
    });
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Audit log export");
    expect(csv).toContain("Rows in this file,2");
    expect(csv).toContain("Snapshot,rows dated at or before 2026-10-13T00:00:00.000Z; a row written after the export began is not in this file");
    expect(csv).toMatch(/Complete,Yes — every row the filters select that you may read/);
    expect(lines).toContain("Timestamp,Action,Action code,Resource Type,Resource ID,Resource Label,User ID,User Email,User Role,Actor kind,Details JSON,Metadata JSON");
    expect(csv).toContain("P-101 · P&ID");
    expect(csv).toContain("(before 20261201: as sent)");
    expect(csv).toContain('"{""asserted"":{""user_role"":""Admin""}}"');
    const stopped = buildAuditCsv([], new Map(), { orgId: "o1", filters: F, exportedAtIso: "x", rows: 50_000, complete: false, ceiling: 50_000 });
    expect(stopped).toMatch(/Complete,NO — stopped at 50000 rows/);
  });
  it("the library filter keeps the library's document rows and its own rows, and counts the rest", () => {
    const rows = [
      { resourceType: "document", resourceId: "d1" }, { resourceType: "document", resourceId: "d2" },
      { resourceType: "library", resourceId: "L1" }, { resourceType: "org", resourceId: "o1" },
    ];
    expect(filterByLibrary(rows, "L1", (id) => (id === "d1" ? "L1" : "L2"))).toEqual({ kept: [rows[0], rows[2]], hidden: 2 });
  });
});
