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
  auditActionFilterOptions, auditActionFilterQuery, pairTicketAttempts, isDestructiveAuditAction, auditActorNote, foldTicketFeed,
  auditFamilyLikePattern,
} from "@/lib/auditActions";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);

/** The 1-based line of `marker` in lib/auditActions.ts (named in a census
 *  failure so the integrator knows where to register a new action). */
const registryLine = (marker: string) => src("lib/auditActions.ts").split("\n").findIndex((l) => l.includes(marker)) + 1;

/** PostgreSQL LIKE with its default backslash escape: `%` any run, `_` one
 *  character, `\x` the literal x. */
function likeMatches(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; re += (pattern[i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(value);
}

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
    for (const m of ["const BY_CATEGORY", "export const AUDIT_ACTION_FAMILIES", "export const AUDIT_RESOURCE_TYPES"]) expect(registryLine(m), m).toBeGreaterThan(0);
    const missing = [...writtenActions()].filter(([a]) => !auditActionDef(a)).map(([a, where]) => `${a} (${where})`);
    // P7 review: a package merging after P7 that writes a new action lands
    // here — the message names the file and the line to add it at.
    expect(missing, `Unregistered audit action(s). Add each to lib/auditActions.ts BY_CATEGORY (line ${registryLine("const BY_CATEGORY")}, in the category it belongs to) or, for a dynamic name, AUDIT_ACTION_FAMILIES (line ${registryLine("export const AUDIT_ACTION_FAMILIES")})`).toEqual([]);
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
      for (const m of s.matchAll(/\bresource_?[tT]ype\s*:\s*["']([a-z_]+)["']/g)) {
        expect(types.has(m[1]), `${p}: resource_type "${m[1]}" is not registered — add it to lib/auditActions.ts AUDIT_RESOURCE_TYPES (line ${registryLine("export const AUDIT_RESOURCE_TYPES")})`).toBe(true);
      }
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
    expect(auditActionFilterQuery("family:TICKET_")).toEqual({ kind: "family", like: "TICKET\\_%" });
    expect(auditActionFilterQuery("DATA_PURGE")).toEqual({ kind: "in", actions: ["DATA_PURGE"] });
    expect(auditActionFilterQuery("ALL")).toBeNull();
    expect(AUDIT_ACTION_FAMILIES.some((f) => f.prefix === "TICKET_")).toBe(true);
    expect(new Set(AUDIT_ACTIONS.map((d) => d.action)).size).toBe(AUDIT_ACTIONS.length);
  });

  it("P7 review: a family's prefix is taken literally — `_` is not a wildcard, so TICKETX_FOO is not a TICKET_ row", () => {
    const like = (auditActionFilterQuery("family:TICKET_") as { like: string }).like;
    expect(likeMatches(like, "TICKET_CLOSE")).toBe(true);
    expect(likeMatches(like, "TICKET_CLOSE_NOT_APPLIED")).toBe(true);
    expect(likeMatches(like, "TICKETX_FOO")).toBe(false);
    expect(likeMatches(like, "TICKETS_FOO")).toBe(false);
    // The unescaped form the review found would have matched it.
    expect(likeMatches("TICKET_%", "TICKETX_FOO")).toBe(true);
    // Every registered family escapes its own `_` / `%`, and still matches its members.
    for (const f of AUDIT_ACTION_FAMILIES) {
      const l = auditFamilyLikePattern(f.prefix);
      expect(likeMatches(l, `${f.prefix}SOMETHING`), f.prefix).toBe(true);
      if (f.prefix.includes("_")) expect(likeMatches(l, `${f.prefix.replace("_", "X")}SOMETHING`), f.prefix).toBe(false);
    }
    expect(auditFamilyLikePattern("A%B\\C_")).toBe("A\\%B\\\\C\\_%");
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
  it("both viewers use the pairing (/activity through foldTicketFeed, so the page stays at one call)", () => {
    expect(src("app/(protected)/admin/audit/page.tsx")).toMatch(/pairTicketAttempts\(/);
    const activity = src("app/(protected)/activity/page.tsx");
    expect(activity).toMatch(/foldTicketFeed\(rows, grouped\)/);
    expect(activity).toMatch(/feed\.groups\.map\(/);
    expect(activity).toMatch(/\+ feed\.verbSuffix\(r\.id\)/);
  });
  it("P7 second review: foldTicketFeed folds a loaded attempt's follow-up into the attempt's line, drops a day left empty, and keeps an orphan follow-up", () => {
    const all = [...rows, { id: "n9", action: "TICKET_CLOSE_NOT_APPLIED", details: { attempt: "not-loaded" } }];
    const groups = [
      { day: "Mon", rows: [all[0], all[1]] }, // n1 (follow-up of a1) and a1
      { day: "Sun", rows: [all[2]] }, // h2 alone: its attempt a2 is loaded elsewhere
      { day: "Sat", rows: [all[3], all[4], all[5], all[6]] },
    ];
    const f = foldTicketFeed(all, groups);
    const ids = f.groups.map((g) => [g.day, g.rows.map((r) => r.id)]);
    expect(ids).toEqual([["Mon", ["a1"]], ["Sat", ["a2", "a3", "old", "n9"]]]);
    expect(f.verbSuffix("a1")).toBe(" (not applied)");
    expect(f.verbSuffix("a2")).toBe(" (applied — its holds were not released)");
    expect(f.verbSuffix("a3")).toBe("");
  });
});

describe("ALOG-5 — /activity states who can read what, and that the database applies it", () => {
  // P7 third review: the stated rule says only what is enforced today.
  const page = () => src("app/(protected)/activity/page.tsx");
  /** The newest migration that re-creates the overlay, and its org-level set. */
  const overlay = () => {
    const dir = join(root, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort()
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("CREATE POLICY audit_logs_admin_trail"));
    const s = readFileSync(join(dir, files[files.length - 1]), "utf8");
    const body = s.slice(s.indexOf("CREATE POLICY audit_logs_admin_trail"));
    const orgLevel = body.slice(0, body.indexOf("-- SEC-20") > 0 ? body.indexOf("-- SEC-20") : body.indexOf(");"));
    return {
      types: [...(/COALESCE\(resource_type, ''\) IN \(([^)]*)\)/.exec(orgLevel)![1].matchAll(/'([a-z_]+)'/g))].map((m) => m[1]),
      prefixes: [...orgLevel.matchAll(/action LIKE '([A-Z_]+)%'/g)].map((m) => m[1].replace(/_$/, "")),
    };
  };

  it("names the Audit log permission rule and the member rule, and that the database applies it", () => {
    const p = page();
    expect(p).toMatch(/workspace-level authority events \(capability policy and workspace settings, members and roles, teams, export destinations and exports, security events, and workspace restores and purges\) are shown only to people with the Audit log permission/);
    expect(p).toMatch(/Every member reads the rest of the workspace&apos;s document-level history/);
    expect(p).toMatch(/The database applies this rule, not this page\./);
  });

  // admin-and-org ALOG-16 (P13, 20261219): the node-level authority rows left
  // the every-member history — the overlay's newest body adds a node-manager
  // clause (they stay OUT of the org-level set, which is still the
  // workspace's own trail).
  it("says permission (ACL), ownership and recertification changes on a library, folder or document reach only Audit log holders and the node's managers — the newest overlay's ALOG-16 clause", () => {
    const p = page();
    expect(p).toMatch(/Permission \(access list\), ownership and recertification changes made on a library, folder or document are shown only to people with the Audit log permission and to those who may manage that library, folder or document/);
    expect(p).not.toMatch(/that includes permission \(access list\), ownership and recertification changes/);
    // ...and that is what the database does: the newest overlay narrows them
    // with audit_row_node_manageable, the action test inline …
    const dir = join(root, "supabase", "migrations");
    const newest = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort()
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("CREATE POLICY audit_logs_admin_trail")).pop()!;
    const sql = readFileSync(join(dir, newest), "utf8");
    expect(sql).toContain("OR audit_row_node_manageable(resource_type, resource_id))");
    expect(sql).toContain("AND ((COALESCE(action, '') NOT IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED')");
    expect(sql).toContain("AND left(COALESCE(action, ''), 11) <> 'OWNER_TEAM_')");
    // … while its org-level set still matches none of these rows (types
    // library / collection / document; no prefix): they are not workspace events.
    const o = overlay();
    expect(o.types).toEqual(expect.arrayContaining(["org", "member", "team", "capability_policy", "org_configuration", "export_destination"]));
    expect(o.prefixes.length).toBeGreaterThan(5); // the parse found the action list (not vacuous)
    for (const t of ["library", "collection", "document"]) expect(o.types).not.toContain(t);
    for (const a of ["NODE_ACL_CHANGED", "OWNER_ASSIGNED", "OWNER_CLEARED", "OWNER_TEAM_ASSIGNED", "ACCESS_RECERTIFIED"]) {
      expect(o.prefixes.some((pre) => a.startsWith(pre)), a).toBe(false);
    }
    expect(src("components/permissions/PermissionDrawer.tsx")).toMatch(/action: "NODE_ACL_CHANGED"/);
    // The header comment names the overlay's whole org-level set.
    for (const t of o.types) expect(p, t).toContain(t);
    for (const pre of o.prefixes) expect(p, pre).toContain(pre);
  });

  it("does not claim the SEC-20 / SEC-21 project scoping (20261142 / 20261157 not confirmed pasted)", () => {
    const p = page();
    expect(p).not.toMatch(/shown only to people who can see that project/);
    const screen = /Who can read this feed:([^<]*)/.exec(p)![1];
    expect(screen).not.toMatch(/project/i);
    expect(p).toMatch(/20261142 and 20261157, neither confirmed pasted/);
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
  AUDIT_EXPORT_ROW_CEILING, AUDIT_CSV_LINES_BEFORE_HEADER, type AuditExportRow,
} from "@/lib/auditLogExport";

/** A PostgREST stand-in for audit_logs that records each call and honours the
 *  keyset reads the export makes: lte / or(after-cursor) / is / lt / order /
 *  limit. Like PostgreSQL, rows that tie on every ORDER BY column come back
 *  in a DIFFERENT order on each query (the fake shuffles ties per query), so
 *  only a total order — "timestamp" DESC, id DESC — pages without loss. */
function pager(n: number, failAt?: number, opts: { tieEvery?: number; undated?: number; seed?: number; maxRows?: number } = {}) {
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
    b.gt = (k: string, v: string) => { calls.push(["gt", [k, v]]); preds.push((r) => r[k] != null && String(r[k]) > v); return b; };
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
      // PostgREST caps every response at the project's max_rows, whatever the limit asked
      const cap = opts.maxRows === undefined ? lim : Math.min(lim, opts.maxRows);
      return Promise.resolve({ data: keyed.slice(0, cap).map((k) => k.r), error: null });
    };
    return b as never;
  };
  return { start, calls, pages: () => pages, all };
}
const F = { range: "all" as const, action: "ALL", resource: "ALL" };

describe("ALOG-6 — the export holds every row the filters select, says its bounds, and is audited", () => {
  it("pages on the server until the rows run out: 2,345 rows in three keyset pages, all in the file (a pass ends on an empty page)", async () => {
    const p = pager(2345);
    const got = await fetchAuditRowsForExport(p.start, F, Date.now());
    expect(got).toMatchObject({ ok: true, complete: true });
    if (got.ok) expect(got.rows).toHaveLength(2345);
    // the (empty) dated-after-start pass, three dated pages of up to 1000 and the empty page that ends
    // the pass, then the (empty) undated pass of "all time"
    expect(p.calls.filter(([m]) => m === "limit").map(([, a]) => a)).toEqual([[1000], [1000], [1000], [1000], [1000], [1000]]);
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

  it("P7 review: a row inserted after the dated-after pass ran is not in the file, and nothing shifts or repeats", async () => {
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

  it("P7 second review: a row DATED after the export began but written before it (a forged future timestamp, a browser clock behind the database) is in the file, listed first and counted", async () => {
    const startMs = Date.UTC(2026, 9, 2);
    const p = pager(120, undefined, { tieEvery: 4 });
    // Three rows already in the log, dated 2027 and a few seconds after the start (ties included).
    p.all.push({ ...p.all[5], id: "f-2027a", timestamp: "2027-03-01T00:00:00.000Z" });
    p.all.push({ ...p.all[6], id: "f-2027b", timestamp: "2027-03-01T00:00:00.000Z" });
    p.all.push({ ...p.all[7], id: "f-skew", timestamp: new Date(startMs + 3_000).toISOString() });
    const got = await fetchAuditRowsForExport(p.start, F, startMs, { page: 2 });
    expect(got).toMatchObject({ ok: true, complete: true, datedAfterStart: 3 });
    const ids = (got as { rows: AuditExportRow[] }).rows.map((r) => r.id);
    expect(ids).toHaveLength(123);
    expect(new Set(ids).size).toBe(123);
    expect(ids.slice(0, 3)).toEqual(["f-2027b", "f-2027a", "f-skew"]);
    expect(p.calls).toEqual(expect.arrayContaining([["gt", ["timestamp", new Date(startMs).toISOString()]]]));
    // A date range keeps them too (the screen filters on the lower bound only).
    const ranged = await fetchAuditRowsForExport(p.start, { ...F, range: "30d" }, startMs, { page: 50 });
    expect((ranged as { rows: AuditExportRow[] }).rows.slice(0, 3).map((r) => r.id)).toEqual(["f-2027b", "f-2027a", "f-skew"]);
    // The file states the count and does not claim the dated-later rows were written later.
    const csv = buildAuditCsv((got as { rows: AuditExportRow[] }).rows, new Map(), {
      orgId: "o1", filters: F, exportedAtIso: new Date(startMs).toISOString(), rows: 123, complete: true, ceiling: 50_000, datedAfterStart: 3,
    });
    expect(csv).toContain('Rows dated after the export began,"3 (included, listed first');
    expect(csv).not.toMatch(/written after the export began is not in this file/);
    expect(csv).toMatch(/Complete,Yes/);
  });

  it("P7 second review: dated-after rows count toward the ceiling, and a stopped file counts only those it holds", async () => {
    const startMs = Date.UTC(2026, 9, 2);
    const p = pager(10);
    for (let j = 0; j < 30; j++) p.all.push({ ...p.all[0], id: `f${String(j).padStart(3, "0")}`, timestamp: new Date(startMs + 1000 * (j + 1)).toISOString() });
    const got = await fetchAuditRowsForExport(p.start, F, startMs, { ceiling: 25, page: 10 });
    expect(got).toMatchObject({ ok: true, complete: false, datedAfterStart: 25 });
    expect((got as { rows: AuditExportRow[] }).rows).toHaveLength(25);
  });

  it("the next page starts strictly after the last row read (keyset, never an offset)", async () => {
    const p = pager(120, undefined, { tieEvery: 10 });
    await fetchAuditRowsForExport(p.start, F, Date.UTC(2026, 9, 2), { page: 50 });
    const ors = p.calls.filter(([m]) => m === "or").map(([, a]) => (a as string[])[0]);
    expect(ors).toHaveLength(3); // after pages 1, 2 and 3 (the third, short, is followed by the empty one that ends the pass)
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
  it("P7 review: a server max_rows below the page size (300 < 1000) still yields every row — a short page is not the end", async () => {
    const startMs = Date.UTC(2026, 9, 2);
    const p = pager(2345, undefined, { tieEvery: 7, undated: 450, maxRows: 300 });
    for (let j = 0; j < 320; j++) p.all.push({ ...p.all[0], id: `f${String(j).padStart(4, "0")}`, timestamp: new Date(startMs + 1000 * (j + 1)).toISOString() });
    const got = await fetchAuditRowsForExport(p.start, F, startMs);
    expect(got).toMatchObject({ ok: true, complete: true, datedAfterStart: 320 });
    const ids = (got as { rows: AuditExportRow[] }).rows.map((r) => r.id);
    expect(ids).toHaveLength(2345 + 450 + 320);
    expect(new Set(ids)).toEqual(new Set(p.all.map((r) => String(r.id))));
    // every request asked for the full page; the server returned at most 300
    expect(p.calls.filter(([m]) => m === "limit").every(([, a]) => (a as number[])[0] === 1000)).toBe(true);
    // and the file says complete only because every row is in it
    const csv = buildAuditCsv((got as { rows: AuditExportRow[] }).rows, new Map(), {
      orgId: "o1", filters: F, exportedAtIso: new Date(startMs).toISOString(), rows: ids.length, complete: true, ceiling: 50_000, datedAfterStart: 320,
    });
    expect(csv).toMatch(/Complete,Yes/);
    // with the cap at the ceiling's edge, the ceiling still stops it
    const capped = await fetchAuditRowsForExport(pager(700, undefined, { maxRows: 300 }).start, F, startMs, { ceiling: 650 });
    expect(capped).toMatchObject({ ok: true, complete: false });
    expect((capped as { rows: AuditExportRow[] }).rows).toHaveLength(650);
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
    expect(fam.calls).toEqual([["like", ["action", "TICKET\\_%"]]]);
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
    expect(csv).toContain('Snapshot,"every row that existed when the export began at 2026-10-13T00:00:00.000Z, newest first by its date; a row inserted while the export ran may or may not be in this file"');
    expect(csv).toContain('Rows dated after the export began,"0 (included, listed first');
    expect(csv).toMatch(/Complete,Yes — every row the filters select that you may read/);
    expect(lines).toContain("Timestamp,Action,Action code,Resource Type,Resource ID,Resource Label,User ID,User Email,User Role,Actor kind,Details JSON,Metadata JSON");
    // P7 review: the recorded shape change — the header is on line
    // AUDIT_CSV_LINES_BEFORE_HEADER + 1 (13 lines of bounds come first), and
    // the page tells whoever imports the file.
    expect(AUDIT_CSV_LINES_BEFORE_HEADER).toBe(13);
    expect(lines[AUDIT_CSV_LINES_BEFORE_HEADER]).toMatch(/^Timestamp,Action,Action code,/);
    expect(lines[AUDIT_CSV_LINES_BEFORE_HEADER - 1]).toBe("");
    expect(lines.slice(0, AUDIT_CSV_LINES_BEFORE_HEADER).filter((l) => l.startsWith("Timestamp,"))).toEqual([]);
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
