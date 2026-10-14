// drafting-flow Round G — DF-P13 SLA DEFAULTS RAIL AND EDITOR.
//
//   EDGE-16  any active member could write sla_defaults, which sets the due
//            date of every request filed without a requested date and the
//            window the SLA clock gives an open request with no target:
//            20261218 narrows INSERT / UPDATE / DELETE to the drafting-
//            configuration editors (DRAFTING_CONFIG_EDITORS — Admin, DocCtrl,
//            DraftingSupervisor; caller_holds_any_role, 20261209's spelling),
//            keeps SELECT unchanged and bounds default_days to 1–3650.
//   EDGE-7   done-when 2's editor: lib/slaDefaultsEditor.ts (validated per
//            request type to the create route's own bound, checked writes
//            that carry the database's refusal text).
//
// This file: the editor's data layer (unit), the migration's DEC-30 shape and
// its byte-fidelity to the newest definitions it mirrors (scanned at test
// time), and the pins on every reader of sla_defaults (unchanged). The
// runtime row-level security per role is lib/__tests__/rls/slaDefaultsRail.test.ts
// (`npm run test:db`); the rendered editor is dfRoundG_P13_slaDefaultsRendered.test.ts.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import {
  SLA_DEFAULTS_RAIL_MIGRATION, SLA_WARN_PERCENT, builtInSlaDays, clearSlaDefault, loadSlaDefaults, parseSlaDays,
  saveSlaDefault, slaWriteFailure, storedWindowUsable, untargetedImpact, warnAfterDays,
} from "@/lib/slaDefaultsEditor";
import { DEFAULT_SLA_DAYS, SLA_DEFAULT_DAYS_MAX, boundedSlaDays } from "@/lib/notifications";
import { ADMIN_SURFACES, DRAFTING_CONFIG_EDITORS } from "@/lib/adminSurfaces";
import { SLA_WARN_FRACTION } from "@/lib/ticketSla";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── a recording PostgREST stand-in ───────────────────────────────────────
type Call = [string, ...unknown[]];
interface Answer { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null }
function client(answer: (table: string, calls: Call[]) => Answer) {
  const log: Array<{ table: string; calls: Call[] }> = [];
  const from = (table: string) => {
    const calls: Call[] = [];
    log.push({ table, calls });
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "is", "lte", "gt", "upsert", "delete", "insert", "update", "order", "limit"]) {
      b[m] = (...args: unknown[]) => { calls.push([m, ...args]); return b; };
    }
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const a = answer(table, calls);
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }).then(res, rej);
    };
    return b;
  };
  return { sb: { from } as unknown as SupabaseClient, log };
}

describe("EDGE-7 done-when 2 — the editor's validation is the create route's own bound", () => {
  it("parseSlaDays: whole days 1–3650, digits only", () => {
    expect(parseSlaDays("1")).toEqual({ ok: true, days: 1 });
    expect(parseSlaDays("3650")).toEqual({ ok: true, days: 3650 });
    expect(parseSlaDays(" 14 ")).toEqual({ ok: true, days: 14 });
    expect(parseSlaDays("007")).toEqual({ ok: true, days: 7 });
    for (const bad of ["0", "3651", "2000000000"]) expect(parseSlaDays(bad), bad).toEqual({ ok: false, error: "Between 1 and 3650 days (ten years)." });
    for (const bad of ["1.5", "-3", "1e3", "abc", "14 days", "+5"]) expect(parseSlaDays(bad), bad).toMatchObject({ ok: false, error: expect.stringContaining("Whole days only") });
    expect(parseSlaDays("")).toEqual({ ok: false, error: "Enter a number of days from 1 to 3650." });
  });
  it("every value the editor accepts is one boundedSlaDays (the create route) accepts, and vice versa over 0..4000", () => {
    for (let n = 0; n <= 4000; n++) expect(parseSlaDays(String(n)).ok, String(n)).toBe(boundedSlaDays(n) !== null);
    expect(SLA_DEFAULT_DAYS_MAX).toBe(3650);
  });
  it("the built-in window is the create route's fallback (DEFAULT_SLA_DAYS, else 14); a stored value outside the bound is flagged", () => {
    expect(builtInSlaDays("ISO")).toBe(14);
    expect(builtInSlaDays("INSPECTION")).toBe(1);
    expect(builtInSlaDays("CUSTOM")).toBe(14);
    expect(DEFAULT_SLA_DAYS).toEqual({ INSPECTION: 1, RFI: 3, MOC: 7, ISO: 14, ASBUILT: 21 });
    expect(storedWindowUsable(7)).toBe(true);
    expect(storedWindowUsable(0)).toBe(false);
    expect(storedWindowUsable(2000000000)).toBe(false);
  });
  it("the warning point is the clock's fixed fraction (warn_before_days is read by no code and not offered)", () => {
    expect(SLA_WARN_FRACTION).toBe(0.75);
    expect(SLA_WARN_PERCENT).toBe(75);
    expect(warnAfterDays(14)).toBe(10);
    expect(warnAfterDays(1)).toBe(0);
    const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const offenders = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /warn_before_days/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("EDGE-7 / EDGE-16 — the editor's writes are checked and carry the database's refusal text", () => {
  it("save: one upsert onConflict org_id,request_type with .select('id'); the row coming back is success", async () => {
    const { sb, log } = client(() => ({ data: [{ id: "r1" }] }));
    expect(await saveSlaDefault(sb, "o1", "ISO", 5)).toEqual({ ok: true });
    expect(log).toHaveLength(1);
    expect(log[0].table).toBe("sla_defaults");
    const [up, sel] = log[0].calls;
    expect(up[0]).toBe("upsert");
    expect(up[1]).toMatchObject({ org_id: "o1", request_type: "ISO", default_days: 5 });
    expect(Object.keys(up[1] as object).sort()).toEqual(["default_days", "org_id", "request_type", "updated_at"]);   // warn_before_days untouched
    expect(up[2]).toEqual({ onConflict: "org_id,request_type" });
    expect(sel).toEqual(["select", "id"]);
  });
  it("save refused by row-level security: the database's own words, and who saves these windows", async () => {
    const { sb } = client(() => ({ error: { code: "42501", message: 'new row violates row-level security policy for table "sla_defaults"' } }));
    const r = await saveSlaDefault(sb, "o1", "ISO", 5);
    expect(r).toEqual({
      ok: false,
      refused: true,
      message: 'Not saved: You don\'t have permission to do this — nothing was changed. The database said: "new row violates row-level security policy for table "sla_defaults"" (42501). Due-date windows are saved by Admin, DocCtrl, DraftingSupervisor.',
    });
  });
  it("save refused by the CHECK (23514): the constraint's own words, not called a permission problem", async () => {
    const { sb } = client(() => ({ error: { code: "23514", message: 'new row for relation "sla_defaults" violates check constraint "sla_defaults_default_days_bounded"' } }));
    const r = await saveSlaDefault(sb, "o1", "ISO", 5);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe(false);
    expect(r.message).toContain('The database said: "new row for relation "sla_defaults" violates check constraint "sla_defaults_default_days_bounded"" (23514).');
    expect(r.message).not.toContain("are saved by");
  });
  it("a write that matched nothing is never a silent success (the checked write's refusal)", async () => {
    const { sb } = client(() => ({ data: [] }));
    const r = await saveSlaDefault(sb, "o1", "ISO", 5);
    expect(r).toEqual({ ok: false, refused: true, message: `Not saved: ${CHECKED_WRITE_REFUSED} Due-date windows are saved by Admin, DocCtrl, DraftingSupervisor.` });
  });
  it("a missing table reads as the migration it needs", async () => {
    const { sb } = client(() => ({ error: { code: "PGRST205", message: "Could not find the table 'public.sla_defaults' in the schema cache" } }));
    const r = await saveSlaDefault(sb, "o1", "ISO", 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^Not saved: This needs the latest database migration applied — nothing was changed\. The database said: /);
  });
  it("clear: delete by org and type with .select('id'); zero rows removed is a refusal (RLS hides the row from a non-editor's DELETE)", async () => {
    const ok = client(() => ({ data: [{ id: "r1" }] }));
    expect(await clearSlaDefault(ok.sb, "o1", "ISO")).toEqual({ ok: true });
    expect(ok.log[0].calls).toEqual([["delete"], ["eq", "org_id", "o1"], ["eq", "request_type", "ISO"], ["select", "id"]]);
    const none = client(() => ({ data: [] }));
    expect(await clearSlaDefault(none.sb, "o1", "ISO")).toEqual({ ok: false, refused: true, message: `Not saved: ${CHECKED_WRITE_REFUSED} Due-date windows are saved by Admin, DocCtrl, DraftingSupervisor.` });
  });
  it("slaWriteFailure: the editor set named is DRAFTING_CONFIG_EDITORS (one list)", () => {
    expect(slaWriteFailure({ ok: false, code: "refused", error: "x" }, null).message).toBe(`Not saved: x Due-date windows are saved by ${DRAFTING_CONFIG_EDITORS.join(", ")}.`);
  });
  it("both writes route through checkedWrite in the source (the SAF-18 rule for a new file)", () => {
    const s = src("lib/slaDefaultsEditor.ts");
    const writes = [...s.matchAll(/\.(upsert|delete|update|insert)\(/g)];
    expect(writes.map((m) => m[1])).toEqual(["upsert", "delete"]);
    for (const m of writes) {
      const before = s.slice(Math.max(0, (m.index ?? 0) - 160), m.index);
      expect(before, m[1]).toContain("await checkedWrite(");
    }
  });
});

describe("the editor's reads", () => {
  it("load: this workspace's rows, mapped; a missing table is said as missing, any other failure is an error (never an empty list)", async () => {
    const ok = client(() => ({ data: [{ id: "a", request_type: "ISO", default_days: 3 }] }));
    expect(await loadSlaDefaults(ok.sb, "o1")).toEqual({ ok: true, rows: [{ id: "a", requestType: "ISO", defaultDays: 3 }] });
    expect(ok.log[0].calls).toEqual([["select", "id, request_type, default_days"], ["eq", "org_id", "o1"]]);
    const missing = client(() => ({ error: { code: "42P01", message: 'relation "sla_defaults" does not exist' } }));
    expect(await loadSlaDefaults(missing.sb, "o1")).toEqual({ ok: false, missing: true, error: 'relation "sla_defaults" does not exist' });
    const down = client(() => ({ error: { code: "57014", message: "statement timeout" } }));
    expect(await loadSlaDefaults(down.sb, "o1")).toEqual({ ok: false, missing: false, error: "statement timeout" });
  });
  it("untargetedImpact counts with the clock's own filters (lib/ticketSla.ts's sla_defaults pass), counts only", async () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const { sb, log } = client((_t, calls) => ({ count: calls.some((c) => c[0] === "gt") ? 2 : 5 }));
    expect(await untargetedImpact(sb, "o1", "ISO", 4, now)).toEqual({ ok: true, impact: { overdue: 5, dueSoon: 2 } });
    const base = [
      ["select", "id", { count: "exact", head: true }], ["eq", "org_id", "o1"], ["eq", "request_type", "ISO"],
      ["not", "status", "in", "(CLOSED,CANCELED)"], ["is", "archived_at", null], ["is", "sla_breached_at", null], ["is", "target_completion_at", null],
    ];
    expect(log.map((l) => l.table)).toEqual(["tickets", "tickets"]);
    expect(log[0].calls).toEqual([...base, ["lte", "created_at", "2026-10-10T12:00:00.000Z"]]);
    expect(log[1].calls).toEqual([...base, ["lte", "created_at", "2026-10-11T12:00:00.000Z"], ["gt", "created_at", "2026-10-10T12:00:00.000Z"], ["is", "sla_breach_warned_at", null]]);
    // the clock's own source carries the same filters (pinned so the two cannot drift)
    const clock = src("lib/ticketSla.ts");
    expect(clock).toContain('.not("status", "in", "(CLOSED,CANCELED)")\n    .is("archived_at", null)\n    .is("sla_breached_at", null);');
    expect(clock).toContain('.lte("created_at", warnFrom)\n          .or(`sla_breach_warned_at.is.null,created_at.lte.${pgq(breachFrom)}`);');
    const failed = client(() => ({ error: { message: "permission denied for table tickets" } }));
    expect(await untargetedImpact(failed.sb, "o1", "ISO", 4, now)).toEqual({ ok: false, error: "permission denied for table tickets" });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 20261218 — the migration
const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const F = "20261218_df_roundG_sla_defaults_rail_editor_writes.sql";
const M = mig(F);
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const PRED = "caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])";

describe("20261218 — every policy on sla_defaults, found by scanning", () => {
  const policyDefs = (text: string) => [...stripComments(text).matchAll(/CREATE POLICY\s+"?([a-z_]+)"?\s+ON\s+(?:public\.)?sla_defaults\b/gi)].map((m) => m[1]);
  it("before this file the table had ONE policy anywhere — 20260605's sla_defaults_member_all (FOR ALL); schema.sql defines none", () => {
    const before = files.filter((f) => f < F).flatMap((f) => policyDefs(mig(f)).map((p) => `${f}:${p}`));
    expect(before).toEqual(["20260605_rls_policies_new_tables.sql:sla_defaults_member_all"]);
    expect(policyDefs(readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8"))).toEqual([]);
    expect(stripComments(mig("20260605_rls_policies_new_tables.sql"))).toContain('CREATE POLICY "sla_defaults_member_all" ON sla_defaults\n  FOR ALL TO authenticated');
  });
  it("this file defines exactly the three RESTRICTIVE write policies, and does not touch sla_defaults_member_all (SELECT unchanged)", () => {
    expect(policyDefs(M)).toEqual(["sla_defaults_editor_writes_ins", "sla_defaults_editor_writes_upd", "sla_defaults_editor_writes_del"]);
    const code = stripComments(M);
    expect(code).not.toMatch(/(DROP|CREATE|ALTER) POLICY[^;]*sla_defaults_member_all/);
    expect(stripComments(between(M, "\nBEGIN;\n", "\nCOMMIT;\n"))).not.toContain("sla_defaults_member_all");
    expect(code).toContain("CREATE POLICY sla_defaults_editor_writes_ins ON sla_defaults\n  AS RESTRICTIVE FOR INSERT\n");
    expect(code).toContain("CREATE POLICY sla_defaults_editor_writes_upd ON sla_defaults\n  AS RESTRICTIVE FOR UPDATE\n");
    expect(code).toContain("CREATE POLICY sla_defaults_editor_writes_del ON sla_defaults\n  AS RESTRICTIVE FOR DELETE\n");
    expect(code).not.toMatch(/FOR SELECT/);
  });
  it("no later file re-creates a policy on sla_defaults (when one does, this test names the file to re-check)", () => {
    expect(files.filter((f) => f > F && policyDefs(mig(f)).length > 0)).toEqual([]);
  });
});

describe("20261218 — byte-fidelity to 20261209's editor predicate (the newest definer, found by scanning)", () => {
  it("lineDiff: every predicate in the transaction IS the 'drafting' predicate of the newest org_config_key_writes_ins, byte for byte — the same helper and spellings", () => {
    const HEAD = "CREATE POLICY org_config_key_writes_ins ON org_configurations";
    const definers = files.filter((f) => f < F && stripComments(mig(f)).includes(HEAD));
    const newest = definers.at(-1)!;
    expect(newest >= "20261209_df_roundG_drafting_config_writes.sql").toBe(true);
    const drafting = [...stripComments(mig(newest)).matchAll(/WHEN 'drafting' THEN (caller_holds_any_role\([^\n]*\]::text\[\]\))/g)].map((m) => m[1]);
    expect(new Set(drafting)).toEqual(new Set([PRED]));
    const tx = stripComments(between(M, "\nBEGIN;\n", "\nCOMMIT;\n"));
    const used = [...tx.matchAll(/caller_holds_any_role\([^\n]*?\]::text\[\]\)/g)].map((m) => m[0]);
    expect(used).toHaveLength(4);   // ins WITH CHECK, upd USING, upd WITH CHECK, del USING
    expect(new Set(used)).toEqual(new Set([PRED]));
    // the three policies, as a lineDiff against the predicate line 20261209 writes: nothing else differs but the policy scaffolding
    const policies = between(M, "DROP POLICY IF EXISTS sla_defaults_editor_writes_ins ON sla_defaults;", "USING (" + PRED + ");");
    const { onlyInB } = lineDiff(`    WHEN 'drafting' THEN ${PRED}`, policies);
    for (const l of onlyInB.filter((x) => x.includes("caller_holds_any_role"))) expect(l.replace(/^\s*(WITH CHECK|USING) \(/, "").replace(/\);?$/, "")).toBe(PRED);
  });
  it("the array is DRAFTING_CONFIG_EDITORS — the set the admin gate holds /admin/requests (entry and writes) to", () => {
    const arr = /ARRAY\[([^\]]+)\]/.exec(PRED)![1].split(",").map((x) => x.replace(/'/g, "").trim());
    expect(arr).toEqual(DRAFTING_CONFIG_EDITORS);
    expect(DRAFTING_CONFIG_EDITORS).toEqual(["Admin", "DocCtrl", "DraftingSupervisor"]);
    const surf = ADMIN_SURFACES.find((s) => s.key === "requests")!;
    expect(surf.entry).toEqual(DRAFTING_CONFIG_EDITORS);
    expect(surf.writes).toEqual(DRAFTING_CONFIG_EDITORS);
  });
  it("caller_holds_any_role is called, never re-defined (20261045's definer: search_path pinned)", () => {
    expect(stripComments(M)).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    const def = mig("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");
    expect(def).toContain("CREATE OR REPLACE FUNCTION caller_holds_any_role(p_org uuid, p_roles text[])\nRETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$");
    expect(files.filter((f) => /FUNCTION\s+caller_holds_any_role\s*\(/.test(stripComments(mig(f))))).toEqual(["20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql"]);
  });
  it("the CHECK's bound is the create route's (1 to SLA_DEFAULT_DAYS_MAX), added NOT VALID and validated only where nothing stored is outside it", () => {
    const code = stripComments(M);
    expect(code).toContain(`ADD CONSTRAINT sla_defaults_default_days_bounded CHECK (default_days BETWEEN 1 AND ${SLA_DEFAULT_DAYS_MAX}) NOT VALID;`);
    expect(code).toContain("ALTER TABLE sla_defaults VALIDATE CONSTRAINT sla_defaults_default_days_bounded;");
    expect(code.indexOf(`IF NOT EXISTS (SELECT 1 FROM sla_defaults WHERE NOT (default_days BETWEEN 1 AND ${SLA_DEFAULT_DAYS_MAX}))`))
      .toBeLessThan(code.indexOf("VALIDATE CONSTRAINT"));
    // nothing stored is rewritten or deleted
    expect(code).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\s+sla_defaults\b/);
  });
});

describe("20261218 — DEC-30 shape", () => {
  it("prerequisite refusal → counts-only inventory BEFORE the transaction → BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    expect(F.startsWith(`${SLA_DEFAULTS_RAIL_MIGRATION}_df_roundG_sla_defaults_rail_`)).toBe(true);
    expect(M.indexOf("RAISE EXCEPTION '20261218 needs caller_holds_any_role")).toBeLessThan(M.indexOf("CREATE TEMP TABLE df_round_g_218_before"));
    expect(M.indexOf("CREATE TEMP TABLE df_round_g_218_before")).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    expect(M.indexOf("\nBEGIN;\n")).toBeLessThan(M.indexOf("\nCOMMIT;\n"));
    expect(M.split("\nBEGIN;\n")).toHaveLength(2);
    expect(M.split("\nCOMMIT;\n")).toHaveLength(2);
    const after = M.slice(M.indexOf("\nCOMMIT;\n"));
    expect((stripComments(after).replace(/UNION ALL\s*\nSELECT/g, "UNION ALL SELECT").match(/^SELECT /gm) ?? []).length).toBe(1);
    expect(after).toContain("AS check,");
    expect(after).toContain("AS ok,");
    expect(after).toContain("NULL::text AS n");
    expect(after).toContain("SELECT inventory, NULL, n FROM df_round_g_218_before;");
  });
  it("the inventory is counts only — never a uid, an email, a name or a row", () => {
    const inv = between(M, "CREATE TEMP TABLE df_round_g_218_before", "\nBEGIN;");
    expect(inv).not.toMatch(/SELECT\s+(m\.|t\.)?(uid|email|display_name|request_type|default_days)\b/);
    const rows = [...inv.matchAll(/^SELECT (\d+)(?: AS ord)?, '/gm)].map((m) => Number(m[1]));
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
  it("probes read deparsed policy text: no bare cast inside a LIKE pattern; every probe's n is NULL", () => {
    const after = stripComments(M.slice(M.indexOf("\nCOMMIT;\n")));
    for (const m of after.matchAll(/LIKE '((?:[^']|'')*)'/g)) expect(m[1], m[1]).not.toContain("::");
    const selects = after.split(/\nUNION ALL\n/);
    expect(selects).toHaveLength(7);   // 6 probes + the inventory rows
    for (const s of selects.slice(1, 6)) expect(s.trimEnd().endsWith("NULL"), s.slice(0, 80)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Every reader of sla_defaults — unchanged (pinned), and the census of who names the table
const walk = (d: string): string[] => readdirSync(join(process.cwd(), d)).flatMap((f) => {
  if (f === "__tests__" || f === "node_modules") return [];
  const rel = `${d}/${f}`;
  return statSync(join(process.cwd(), rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the readers of sla_defaults are unchanged (EDGE-16: every reader as before)", () => {
  it("census: the files that name the table are the two readers, the editor, the export / restore lists, the schema registry and one comment", () => {
    const naming = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /\bsla_defaults\b/.test(src(f))).sort();
    expect(naming).toEqual([
      "app/(protected)/admin/requests/page.tsx",
      "app/api/tickets/create/route.ts",
      "lib/dataRestore.ts",
      "lib/exportTables.ts",
      "lib/notifications.ts",
      "lib/schemaExpectations.ts",
      "lib/slaDefaultsEditor.ts",
      "lib/ticketSla.ts",
    ]);
    const fromSites = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /\.from\(\s*["']sla_defaults["']\s*\)/.test(src(f))).sort();
    expect(fromSites).toEqual(["app/api/tickets/create/route.ts", "lib/slaDefaultsEditor.ts", "lib/ticketSla.ts"]);
    // the page names the table only in its comment; its reads and writes are the editor module's
    expect(src("app/(protected)/admin/requests/page.tsx")).not.toMatch(/\.from\(\s*['"]sla_defaults['"]/);
  });
  it("the create route reads it as before: as the service role, the requester's date first, bounded by boundedSlaDays, the built-in window on any failure", () => {
    const r = src("app/api/tickets/create/route.ts");
    expect(r).toContain('    const { data: slaRow, error: slaErr } = await supabaseAdmin\n      .from("sla_defaults").select("default_days").eq("org_id", orgId).eq("request_type", input.requestType).maybeSingle();');
    expect(r).toContain("    const days = slaErr ? null : boundedSlaDays(rawDays);");
    expect(r).toContain("    targetCompletionAt = fromWindow ?? defaultSlaTargetDate(input.requestType);");
    expect(r).toContain("  let targetCompletionAt = input.targetCompletionAt;\n  if (!targetCompletionAt) {");
  });
  it("the SLA clock reads it as before: every row, skipping a non-positive window", () => {
    const c = src("lib/ticketSla.ts");
    expect(c).toContain('  const { data: defs, error: defErr } = await sb.from("sla_defaults").select("org_id, request_type, default_days");');
    expect(c).toContain("    if (!d.org_id || !d.request_type || !(Number(d.default_days) > 0)) continue;");
  });
  it("boundedSlaDays keeps its rule (the shared bound the editor and the CHECK use)", () => {
    expect(boundedSlaDays(1)).toBe(1);
    expect(boundedSlaDays(3650)).toBe(3650);
    expect(boundedSlaDays("12")).toBe(12);
    for (const bad of [0, -1, 3651, 1.5, 2e9, "x", "", null, undefined, true]) expect(boundedSlaDays(bad), String(bad)).toBeNull();
  });
});
