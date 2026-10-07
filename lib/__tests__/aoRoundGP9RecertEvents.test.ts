// admin-and-org Round G — package P9, ALOG-2 / document-control RET-4:
// 20261188 — access_recertification_events ends with a member SELECT, an
// INSERT bound to performed_by = auth.uid() for the library's owner or a
// controller (also RESTRICTIVE), and RESTRICTIVE no-UPDATE / no-DELETE —
// proved by replaying schema.sql and every numbered migration at test time;
// the file has the DEC-30 shape. (Exercised on a throwaway PostgreSQL 16 by
// the package: the probes, an idempotent re-run, and each caller — see
// ALOG-2's record.) The app half is in accessRecert.test.ts and
// aoRoundGP9RecertModalRendered.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MIG = "supabase/migrations/20261188_ao_roundG_access_recert_events.sql";

// ── a policy census: schema.sql, then every numbered migration, in order ────
// (the same replay aoRoundGP0Records.test.ts uses for org_members)
function finalPolicies(tableName: string): Map<string, { cmd: string; body: string; file: string; restrictive: boolean }> {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = ["supabase/schema.sql", ...readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort().map((f) => `supabase/migrations/${f}`)];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
  const out = new Map<string, { cmd: string; body: string; file: string; restrictive: boolean }>();
  for (const file of files) {
    const txt = strip(src(file));
    const events: Array<{ at: number; drop: boolean; name: string; cmd?: string; body?: string }> = [];
    for (const m of txt.matchAll(/CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)\b([\s\S]*?);/gi)) {
      if (m[2] !== tableName) continue;
      const cmd = (/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(m[3])?.[1] ?? "ALL").toUpperCase();
      events.push({ at: m.index ?? 0, drop: false, name: m[1], cmd, body: m[3] });
    }
    for (const m of txt.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)/gi)) {
      if (m[2] === tableName) events.push({ at: m.index ?? 0, drop: true, name: m[1] });
    }
    // The 20260819 loop builds `<table>_member_all` with format(): count it
    // as a FOR ALL member policy on every table its ARRAY names.
    const loop = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\] LOOP([\s\S]*?)END LOOP/i.exec(txt);
    if (loop && loop[1].includes(`'${tableName}'`) && /_member_all/.test(loop[2]) && /FOR ALL/.test(loop[2])) {
      events.push({ at: loop.index, drop: false, name: `${tableName}_member_all`, cmd: "ALL", body: loop[2] });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.drop) out.delete(e.name);
      else out.set(e.name, { cmd: e.cmd!, body: e.body!, file, restrictive: /AS\s+RESTRICTIVE/i.test(e.body!) });
    }
  }
  return out;
}

describe("ALOG-2 / RET-4 — 20261188: the attestation record is bound, narrowed and append-only", () => {
  const T = "access_recertification_events";

  it("before 20261188 the sequence held exactly the two member FOR ALL policies this file drops", () => {
    const sql = src(MIG);
    expect(sql).toContain('DROP POLICY IF EXISTS "access_recert_events_member" ON access_recertification_events;');
    expect(sql).toContain('DROP POLICY IF EXISTS "access_recertification_events_member_all" ON access_recertification_events;');
    // The census itself sees both (so the drops are not dropping nothing).
    expect(src("supabase/migrations/20260821_access_recert.sql")).toMatch(/CREATE POLICY "access_recert_events_member" ON access_recertification_events\s+FOR ALL/);
    expect(src("supabase/migrations/20260819_orphan_tables_backfill.sql")).toMatch(/'access_recertification_events'[\s\S]*_member_all[\s\S]*FOR ALL TO authenticated/);
  });

  it("replaying schema.sql then every numbered migration leaves SELECT (member), INSERT (bound), and RESTRICTIVE INSERT / no-UPDATE / no-DELETE — no FOR ALL", () => {
    const final = finalPolicies(T);
    expect(Object.fromEntries([...final].map(([n, p]) => [n, `${p.restrictive ? "R:" : ""}${p.cmd}`]))).toEqual({
      access_recert_events_select: "SELECT",
      access_recert_events_insert: "INSERT",
      access_recert_events_insert_authority: "R:INSERT",
      access_recert_events_no_update: "R:UPDATE",
      access_recert_events_no_delete: "R:DELETE",
    });
    expect([...final.values()].some((p) => p.cmd === "ALL")).toBe(false);
    for (const p of final.values()) expect(p.file).toBe(MIG);
  });

  it("the INSERT binds performed_by to the caller, an active membership, the library's own org, and owner-or-controller", () => {
    const final = finalPolicies(T);
    for (const name of ["access_recert_events_insert", "access_recert_events_insert_authority"]) {
      const b = final.get(name)!.body;
      expect(b, name).toContain("performed_by = auth.uid()");
      expect(b, name).toContain("l.id = access_recertification_events.library_id");
      expect(b, name).toContain("l.org_id = access_recertification_events.org_id");
      expect(b, name).toContain("(is_org_controller(l.org_id) OR l.owner_user_id::text = auth.uid()::text)");
    }
    const ins = final.get("access_recert_events_insert")!.body;
    expect(ins).toMatch(/FOR INSERT TO authenticated/);
    expect(ins).toContain("m.org_id = access_recertification_events.org_id AND m.uid = auth.uid() AND m.status = 'active'");
    const sel = final.get("access_recert_events_select")!.body;
    expect(sel).toMatch(/FOR SELECT TO authenticated/);
    expect(sel).toContain("m.org_id = access_recertification_events.org_id AND m.uid = auth.uid() AND m.status = 'active'");
    expect(final.get("access_recert_events_no_update")!.body).toMatch(/AS RESTRICTIVE FOR UPDATE USING \(false\)/);
    expect(final.get("access_recert_events_no_delete")!.body).toMatch(/AS RESTRICTIVE FOR DELETE USING \(false\)/);
  });

  it("the recertifier set is the one the library guard (20261077 §2), the page and the scan already use — controller by collection, or owner_user_id", () => {
    const guard = src("supabase/migrations/20261077_dc_roundF_records_rails.sql");
    expect(guard).toMatch(/IF NOT is_org_controller\(OLD\.org_id\)\s+AND OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text THEN\s+RAISE EXCEPTION 'Only an Admin, Document Controller or the library owner can record an access recertification\.'/);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toContain('const isController = hasAnyRole(["Admin", "DocCtrl"]);');
    expect(page).toContain("const isLibraryOwner = !!uid && !!library?.ownerUserId && library.ownerUserId === uid;");
    expect(page).toContain("{(isController || isLibraryOwner) && (");
    const lib = src("lib/accessRecert.ts");
    expect(lib).toContain("const targets = uniq([...(ownerId ? [ownerId] : []), ...controllers]);");
    // is_org_controller reads the collection (role IN … OR roles && …) and active membership.
    expect(src("supabase/migrations/20260814_documents_delete_controllers.sql"))
      .toMatch(/AND status = 'active'\s+AND \(role IN \('Admin', 'DocCtrl'\) OR roles && ARRAY\['Admin', 'DocCtrl'\]::text\[\]\)/);
  });

  it("DEC-30 shape: TEMP counts-only inventory BEFORE the transaction, one BEGIN/COMMIT, ONE final SELECT (check, ok, n); no function, no SECURITY DEFINER", () => {
    const sql = src(MIG);
    const code = sql.replace(/--[^\n]*/g, "");
    const temp = code.indexOf("CREATE TEMP TABLE _ao_g88_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = code.slice(commit + "\nCOMMIT;".length);
    // exactly one statement after COMMIT: the verification SELECT
    expect(tail.trim().split(/;\s*/).filter(Boolean)).toHaveLength(1);
    expect(tail).toMatch(/^\s*SELECT 'access_recertification_events: RLS still on' AS check,[\s\S]*AS ok,\s+NULL::text AS n/);
    expect(tail.trim().endsWith("UNION ALL SELECT inventory, NULL, n FROM _ao_g88_before;")).toBe(true);
    // the inventory is aggregate counts only
    const inv = code.slice(temp, begin);
    expect(inv.match(/\bSELECT\b(?!\s+1\b)/g)!.length).toBe(inv.match(/COUNT\(\*\)::text/g)!.length);
    expect(code).not.toMatch(/SECURITY DEFINER|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER/i);
    // pg_policies probes compare deparsed text with LIKE, never a bare cast
    expect(tail).not.toMatch(/LIKE '%[^']*::[a-z]/);
  });
});

